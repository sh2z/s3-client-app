// S3 Client module for Tauri backend
use anyhow::{Context, Result};
use aws_config::BehaviorVersion;
use aws_sdk_s3::config::{Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::Client;
use aws_sdk_s3::Config;
use bytes::Bytes;
use crate::config_manager::DataSource;
use futures::stream::Stream;
use log::info;
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::fs::File;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio::sync::Notify;
use urlencoding::encode;
use lazy_static::lazy_static;
use http_body_0_4::Body;

// Default region
pub const DEFAULT_REGION: &str = "us-east-1";
// Maximum concurrent tasks
pub const MAX_CONCURRENT_TASKS: usize = 50;
// Chunk size, 10 MB
pub const CHUNK_SIZE: usize = 10 * 1024 * 1024;

/// Guess MIME type from file path
fn guess_mime_type(path: &str) -> &'static str {
    let path_lower = path.to_lowercase();
    if path_lower.ends_with(".txt") {
        "text/plain"
    } else if path_lower.ends_with(".html") || path_lower.ends_with(".htm") {
        "text/html"
    } else if path_lower.ends_with(".css") {
        "text/css"
    } else if path_lower.ends_with(".js") {
        "application/javascript"
    } else if path_lower.ends_with(".json") {
        "application/json"
    } else if path_lower.ends_with(".xml") {
        "application/xml"
    } else if path_lower.ends_with(".png") {
        "image/png"
    } else if path_lower.ends_with(".jpg") || path_lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if path_lower.ends_with(".gif") {
        "image/gif"
    } else if path_lower.ends_with(".svg") {
        "image/svg+xml"
    } else if path_lower.ends_with(".webp") {
        "image/webp"
    } else if path_lower.ends_with(".pdf") {
        "application/pdf"
    } else if path_lower.ends_with(".zip") {
        "application/zip"
    } else if path_lower.ends_with(".gz") || path_lower.ends_with(".gzip") {
        "application/gzip"
    } else if path_lower.ends_with(".tar") {
        "application/x-tar"
    } else if path_lower.ends_with(".mp4") {
        "video/mp4"
    } else if path_lower.ends_with(".mp3") {
        "audio/mpeg"
    } else if path_lower.ends_with(".md") {
        "text/markdown"
    } else if path_lower.ends_with(".csv") {
        "text/csv"
    } else if path_lower.ends_with(".yaml") || path_lower.ends_with(".yml") {
        "application/yaml"
    } else {
        "application/octet-stream"
    }
}

pub type ProgressFn = Arc<dyn Fn(u64, Option<u64>) + Send + Sync>;

#[derive(Debug)]
pub struct TransferControl {
    paused: AtomicBool,
    notify: Notify,
    waker: Mutex<Option<std::task::Waker>>,
}

impl TransferControl {
    fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            notify: Notify::new(),
            waker: Mutex::new(None),
        }
    }

    fn pause(&self) {
        self.paused.store(true, Ordering::Relaxed);
    }

    fn resume(&self) {
        self.paused.store(false, Ordering::Relaxed);
        self.notify.notify_waiters();
        if let Some(waker) = self.waker.lock().unwrap().take() {
            waker.wake();
        }
    }

    fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }

    async fn wait_if_paused(&self) {
        while self.is_paused() {
            self.notify.notified().await;
        }
    }

    fn store_waker(&self, waker: &std::task::Waker) {
        let mut guard = self.waker.lock().unwrap();
        *guard = Some(waker.clone());
    }
}

lazy_static! {
    static ref TRANSFER_CONTROLS: Mutex<HashMap<String, Arc<TransferControl>>> = Mutex::new(HashMap::new());
}

pub fn get_or_create_transfer_control(id: &str) -> Arc<TransferControl> {
    let mut map = TRANSFER_CONTROLS.lock().unwrap();
    map.entry(id.to_string())
        .or_insert_with(|| Arc::new(TransferControl::new()))
        .clone()
}

pub fn remove_transfer_control(id: &str) {
    let mut map = TRANSFER_CONTROLS.lock().unwrap();
    map.remove(id);
}

pub fn pause_transfer(id: &str) -> bool {
    if let Some(control) = TRANSFER_CONTROLS.lock().unwrap().get(id) {
        control.pause();
        true
    } else {
        false
    }
}

pub fn resume_transfer(id: &str) -> bool {
    if let Some(control) = TRANSFER_CONTROLS.lock().unwrap().get(id) {
        control.resume();
        true
    } else {
        false
    }
}

struct ProgressBody<S> {
    stream: S,
    transferred: u64,
    total: Option<u64>,
    progress: Option<ProgressFn>,
    done: bool,
    control: Option<Arc<TransferControl>>,
}

impl<S> ProgressBody<S> {
    fn new(
        stream: S,
        total: Option<u64>,
        progress: Option<ProgressFn>,
        control: Option<Arc<TransferControl>>,
    ) -> Self {
        Self {
            stream,
            transferred: 0,
            total,
            progress,
            done: false,
            control,
        }
    }
}

impl<S> Body for ProgressBody<S>
where
    S: Stream<Item = Result<Bytes, std::io::Error>> + Unpin + Send + 'static,
{
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_data(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<Self::Data, Self::Error>>> {
        if let Some(control) = &self.control {
            if control.is_paused() {
                control.store_waker(cx.waker());
                return std::task::Poll::Pending;
            }
        }
        match Pin::new(&mut self.stream).poll_next(cx) {
            std::task::Poll::Ready(Some(Ok(bytes))) => {
                self.transferred = self.transferred.saturating_add(bytes.len() as u64);
                if let Some(progress) = &self.progress {
                    progress(self.transferred, self.total);
                }
                std::task::Poll::Ready(Some(Ok(bytes)))
            }
            std::task::Poll::Ready(None) => {
                self.done = true;
                std::task::Poll::Ready(None)
            }
            other => other,
        }
    }

    fn poll_trailers(
        self: Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Result<Option<http::HeaderMap<http::HeaderValue>>, Self::Error>> {
        std::task::Poll::Ready(Ok(None))
    }

    fn is_end_stream(&self) -> bool {
        if let Some(total) = self.total {
            self.transferred >= total
        } else {
            self.done
        }
    }

    fn size_hint(&self) -> http_body_0_4::SizeHint {
        let mut hint = http_body_0_4::SizeHint::default();
        if let Some(total) = self.total {
            hint.set_exact(total);
        }
        hint
    }
}

// Client cache to reuse connections
lazy_static! {
    static ref CLIENT_CACHE: Mutex<HashMap<String, Client>> = Mutex::new(HashMap::new());
    static ref CLIENT_LRU: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
}
const MAX_CACHED_CLIENTS: usize = 3;

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct S3ClientConfig {
    pub access_key: String,
    pub secret_key: String,
    pub endpoint: String,
}

impl S3ClientConfig {
    pub fn new(access_key: String, secret_key: String, endpoint: String) -> Self {
        Self {
            access_key,
            secret_key,
            endpoint,
        }
    }
    
    pub async fn create_client(&self, region: &str) -> Client {
        let region = region.to_string();
        let credentials = Credentials::new(&self.access_key, &self.secret_key, None, None, "env");
        let s3_config = Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .credentials_provider(credentials)
            .region(Region::new(region))
            .endpoint_url(&self.endpoint)
            .force_path_style(true)
            .build();

        Client::from_conf(s3_config)
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct BucketInfo {
    pub name: String,
    pub size: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ObjectInfo {
    pub key: String,
    pub size: Option<i64>,
    pub last_modified: Option<String>,
    pub is_folder: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ListObjectsResponse {
    pub objects: Vec<ObjectInfo>,
    pub next_continuation_token: Option<String>,
    pub has_more: bool,
    pub total_size: i64,
}

/// Format S3 SDK error into a human-readable message
fn format_s3_error<E>(error: &aws_sdk_s3::error::SdkError<E>, bucket: &str, key: &str) -> String 
where
    E: std::fmt::Debug,
{
    use aws_sdk_s3::error::SdkError;
    
    match error {
        SdkError::ServiceError(e) => {
            let err = e.err();
            format!("S3 service error: {:?} (bucket: {}, key: {})", err, bucket, key)
        }
        SdkError::DispatchFailure(e) => {
            format!("Network error - failed to connect to S3 endpoint: {:?} (bucket: {}, key: {})", e, bucket, key)
        }
        SdkError::TimeoutError(_) => {
            format!("Request timeout - S3 server did not respond in time (bucket: {}, key: {})", bucket, key)
        }
        SdkError::ResponseError(e) => {
            format!("Invalid response from S3: {:?} (bucket: {}, key: {})", e, bucket, key)
        }
        SdkError::ConstructionFailure(e) => {
            format!("Request construction failed: {:?} (bucket: {}, key: {})", e, bucket, key)
        }
        _ => {
            format!("S3 error: {:?} (bucket: {}, key: {})", error, bucket, key)
        }
    }
}

pub struct S3Operations;

impl S3Operations {
    fn touch_client_lru(key: &str) {
        let mut lru = CLIENT_LRU.lock().unwrap();
        if let Some(pos) = lru.iter().position(|k| k == key) {
            lru.remove(pos);
        }
        lru.push_back(key.to_string());
    }

    fn insert_client_cache(key: String, client: Client) {
        let mut cache = CLIENT_CACHE.lock().unwrap();
        let mut lru = CLIENT_LRU.lock().unwrap();
        cache.insert(key.clone(), client);
        if let Some(pos) = lru.iter().position(|k| k == &key) {
            lru.remove(pos);
        }
        lru.push_back(key.clone());
        while lru.len() > MAX_CACHED_CLIENTS {
            if let Some(oldest) = lru.pop_front() {
                cache.remove(&oldest);
                info!("Evicted cached S3 client {}", oldest);
            }
        }
    }

    /// Create a client key for caching
    fn get_client_key(config: &DataSource) -> String {
        format!("{}:{}:{}:{}", config.endpoint, config.bucket, config.region, config.access_key)
    }
    
    /// Create a client from DataSource with caching
    async fn create_client(config: &DataSource) -> Client {
        let key = Self::get_client_key(config);
        
        // Try to get from cache first
        {
            let cache = CLIENT_CACHE.lock().unwrap();
            if let Some(client) = cache.get(&key) {
                info!("Using cached S3 client for {}", config.bucket);
                let cloned = client.clone();
                drop(cache);
                Self::touch_client_lru(&key);
                return cloned;
            }
        }
        
        // Create new client
        info!("Creating new S3 client for {} at {}", config.bucket, config.endpoint);
        let start = Instant::now();
        
        let region = config.region.clone();
        let credentials = Credentials::new(&config.access_key, &config.secret_key, None, None, "env");
        let s3_config = Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .credentials_provider(credentials)
            .region(Region::new(region))
            .endpoint_url(&config.endpoint)
            .force_path_style(true)
            .build();

        let client = Client::from_conf(s3_config);
        
        info!("S3 client created in {:?}", start.elapsed());
        
        // Store in cache
        Self::insert_client_cache(key, client.clone());
        
        client
    }

    /// Warm up connection for a data source (pre-establish TCP/TLS connection)
    pub async fn warm_up_connection(config: &DataSource) -> Result<()> {
        info!("Warming up connection for {} at {}", config.bucket, config.endpoint);
        let start = Instant::now();
        
        // Use list_objects to actually establish the connection
        // This is more effective than just creating the client
        let _ = Self::list_objects(config, "", None, Some(100)).await?;
        
        info!("Connection warmed up for {} in {:?}", config.bucket, start.elapsed());
        Ok(())
    }

    /// List all buckets
    pub async fn list_buckets(config: &DataSource) -> Result<Vec<String>> {
        let start = Instant::now();
        let client = Self::create_client(config).await;
        let resp = client.list_buckets().send().await?;
        let buckets: Vec<String> = resp
            .buckets()
            .iter()
            .map(|b| b.name.as_ref().unwrap_or(&"[Unknown]".to_string()).to_string())
            .collect();
        info!("list_buckets completed in {:?}", start.elapsed());
        Ok(buckets)
    }

    /// AWS S3 max page size is 1000
    const AWS_MAX_PAGE_SIZE: i32 = 1000;
    /// Default batch size for loading multiple pages (e.g., 5000 = 5 pages of 1000)
    const DEFAULT_BATCH_SIZE: i32 = 5000;

    /// List objects in a bucket with optional prefix
    /// Supports pagination with continuation_token
    /// Automatically batches multiple requests if batch_size > 1000
    pub async fn list_objects(
        config: &DataSource, 
        prefix: &str,
        continuation_token: Option<String>,
        batch_size: Option<i32>
    ) -> Result<ListObjectsResponse> {
        let start = Instant::now();
        let client = Self::create_client(config).await;
        let mut resp: Vec<ObjectInfo> = Vec::new();
        let mut total_size: i64 = 0;
        
        // Determine target batch size (default 5000)
        let target_batch_size = batch_size.unwrap_or(Self::DEFAULT_BATCH_SIZE);
        let max_pages = ((target_batch_size + Self::AWS_MAX_PAGE_SIZE - 1) / Self::AWS_MAX_PAGE_SIZE) as usize;
        
        let mut current_token = continuation_token;
        let mut pages_loaded = 0;
        let mut has_more = false;
        let mut next_continuation_token: Option<String> = None;

        info!(
            "Starting list_objects batch for bucket: {}, prefix: {}, target_batch_size: {}, max_pages: {}",
            config.bucket, prefix, target_batch_size, max_pages
        );

        // Loop to fetch multiple pages until we reach target_batch_size or no more results
        while pages_loaded < max_pages {
            // Build the request
            let mut request = client
                .list_objects_v2()
                .bucket(&config.bucket)
                .prefix(prefix)
                .delimiter("/")
                .max_keys(Self::AWS_MAX_PAGE_SIZE);

            // Add continuation token if provided
            if let Some(ref token) = current_token {
                request = request.continuation_token(token.clone());
            }

            info!(
                "Sending list_objects_v2 request page {}/{} for bucket: {}",
                pages_loaded + 1,
                max_pages,
                config.bucket
            );
            
            let req_start = Instant::now();
            let result = request.send().await?;
            info!("list_objects_v2 page {} received in {:?}", pages_loaded + 1, req_start.elapsed());

            // Collect common prefixes (folders)
            for prefix_result in result.common_prefixes() {
                let key = prefix_result.prefix().unwrap_or("");
                // Avoid duplicate folders when loading multiple pages
                if !resp.iter().any(|obj| obj.key == key && obj.is_folder) {
                    resp.push(ObjectInfo {
                        key: key.to_string(),
                        size: None,
                        last_modified: None,
                        is_folder: true,
                    });
                }
            }

            // Collect objects (files) and calculate total size
            for obj in result.contents() {
                let key = obj.key().unwrap_or("");
                let size = obj.size().unwrap_or(0);
                total_size += size;
                resp.push(ObjectInfo {
                    key: key.to_string(),
                    size: Some(size),
                    last_modified: obj.last_modified().map(|t: &aws_sdk_s3::primitives::DateTime| t.to_string()),
                    is_folder: false,
                });
            }

            pages_loaded += 1;
            
            // Check if there are more results
            has_more = result.is_truncated().unwrap_or(false);
            next_continuation_token = result.next_continuation_token().map(|s| s.to_string());
            
            info!(
                "Page {} completed, loaded {} total objects so far, has_more: {}",
                pages_loaded,
                resp.len(),
                has_more
            );

            // Break if no more results or we've loaded enough
            if !has_more || next_continuation_token.is_none() {
                break;
            }
            
            // Continue to next page
            current_token = next_continuation_token.clone();
        }

        info!(
            "list_objects batch completed in {:?}, loaded {} pages, found {} objects, total size: {}",
            start.elapsed(),
            pages_loaded,
            resp.len(),
            total_size
        );

        Ok(ListObjectsResponse {
            objects: resp,
            next_continuation_token,
            has_more,
            total_size,
        })
    }

    /// Search all objects in bucket matching the query (case-insensitive)
    /// This traverses the entire bucket and filters matching objects
    pub async fn search_objects(
        config: &DataSource,
        query: &str,
    ) -> Result<ListObjectsResponse> {
        let start = Instant::now();
        let client = Self::create_client(config).await;
        let mut resp: Vec<ObjectInfo> = Vec::new();
        let mut total_size: i64 = 0;
        let mut continuation_token: Option<String> = None;
        let query_lower = query.to_lowercase();
        const BATCH_SIZE: i32 = 1000;

        info!(
            "Starting search for '{}' in bucket: {}",
            query, config.bucket
        );

        // Loop through all objects in the bucket
        loop {
            let mut request = client
                .list_objects_v2()
                .bucket(&config.bucket)
                .max_keys(BATCH_SIZE);

            if let Some(token) = continuation_token {
                request = request.continuation_token(token);
            }

            let result = request.send().await?;

            // Filter objects matching the search query
            for obj in result.contents() {
                let key = obj.key().unwrap_or("");
                let size = obj.size().unwrap_or(0);
                
                // Case-insensitive search on the full key
                if key.to_lowercase().contains(&query_lower) {
                    resp.push(ObjectInfo {
                        key: key.to_string(),
                        size: Some(size),
                        last_modified: obj.last_modified().map(|t: &aws_sdk_s3::primitives::DateTime| t.to_string()),
                        is_folder: key.ends_with('/'),
                    });
                    total_size += size;
                }
            }

            // Check if there are more results
            if result.is_truncated().unwrap_or(false) {
                continuation_token = result.next_continuation_token().map(|s| s.to_string());
            } else {
                break;
            }
        }

        info!(
            "Search completed in {:?}, found {} matching objects",
            start.elapsed(),
            resp.len()
        );

        Ok(ListObjectsResponse {
            objects: resp,
            next_continuation_token: None,
            has_more: false,
            total_size,
        })
    }

    /// Get total bucket size (similar to s3cmd du s3://bucket)
    /// This recursively calculates the size of all objects in the bucket
    pub async fn get_bucket_total_size(config: &DataSource) -> Result<i64> {
        let client = Self::create_client(config).await;
        let mut total_size: i64 = 0;
        let mut continuation_token: Option<String> = None;
        const BATCH_SIZE: i32 = 1000;

        loop {
            let mut request = client
                .list_objects_v2()
                .bucket(&config.bucket)
                .max_keys(BATCH_SIZE);

            if let Some(token) = continuation_token {
                request = request.continuation_token(token);
            }

            let result = request.send().await?;

            // Sum up all object sizes in this batch
            for obj in result.contents() {
                total_size += obj.size().unwrap_or(0);
            }

            // Check if there are more results
            if result.is_truncated().unwrap_or(false) {
                continuation_token = result.next_continuation_token().map(|s| s.to_string());
            } else {
                break;
            }
        }

        info!(
            "Total bucket size for '{}': {} bytes",
            config.bucket, total_size
        );

        Ok(total_size)
    }

    /// Upload file
    /// 参考 s3-example-cli 的实现，不设置 content_length 和 content_type
    /// 兼容自建 S3 服务器（如 Ceph、MinIO）
    pub async fn upload_file(
        config: &DataSource,
        local_path: &str,
        key: &str,
        progress: Option<ProgressFn>,
        control: Option<Arc<TransferControl>>,
    ) -> Result<()> {
        let client = Self::create_client(config).await;
        
        // Report initial progress (0%)
        if let Some(ref progress) = progress {
            progress(0, None);
        }
        
        // Check control before uploading
        if let Some(ref control) = control {
            control.wait_if_paused().await;
        }
        
        // 读取文件内容（参考 s3-example-cli 的实现）
        let body = tokio::fs::read(local_path).await
            .with_context(|| format!("Failed to read file: {}", local_path))?;
        let body_stream = ByteStream::from(body);
        
        let result = client
            .put_object()
            .bucket(&config.bucket)
            .key(key)
            .body(body_stream)
            .send()
            .await;
            
        match result {
            Ok(_) => {
                // Report completion
                if let Some(ref progress) = progress {
                    progress(1, Some(1));
                }
                info!("File {} uploaded successfully.", key);
                Ok(())
            }
            Err(e) => {
                let error_msg = format_s3_error(&e, &config.bucket, key);
                Err(anyhow::anyhow!(error_msg))
            }
        }
    }
    
    /// Upload file from bytes
    /// 参考 s3-example-cli 的实现，不设置 content_length 和 content_type
    /// 兼容自建 S3 服务器（如 Ceph、MinIO）
    pub async fn upload_file_bytes(
        config: &DataSource,
        data: &[u8],
        key: &str,
        progress: Option<ProgressFn>,
        control: Option<Arc<TransferControl>>,
    ) -> Result<()> {
        let client = Self::create_client(config).await;
        
        // Report initial progress (0%)
        if let Some(ref progress) = &progress {
            progress(0, None);
        }
        
        // Check control before uploading
        if let Some(ref control) = control {
            control.wait_if_paused().await;
        }
        
        // 直接使用 ByteStream::from（参考 s3-example-cli 的实现）
        let body = ByteStream::from(data.to_vec());
        
        let result = client
            .put_object()
            .bucket(&config.bucket)
            .key(key)
            .body(body)
            .send()
            .await;
            
        match result {
            Ok(_) => {
                // Report completion
                if let Some(ref progress) = progress {
                    progress(1, Some(1));
                }
                info!("File {} uploaded successfully from bytes.", key);
                Ok(())
            }
            Err(e) => {
                let error_msg = format_s3_error(&e, &config.bucket, key);
                Err(anyhow::anyhow!(error_msg))
            }
        }
    }

    /// Download file
    pub async fn download_file(
        config: &DataSource,
        key: &str,
        dest_path: &str,
        progress: Option<ProgressFn>,
        control: Option<Arc<TransferControl>>,
    ) -> Result<()> {
        let client = Self::create_client(config).await;
        let resp = client.get_object().bucket(&config.bucket).key(key).send().await?;
        let total = resp.content_length().map(|v| v as u64);
        let p = Path::new(dest_path)
            .parent()
            .ok_or(anyhow::format_err!("Parent directory not found"))?;
        tokio::fs::create_dir_all(p).await.context("Failed to create directory")?;
        let file = File::create(dest_path).await?;
        let mut writer = BufWriter::with_capacity(4 * 1024 * 1024, file);
        let mut stream = resp.body;
        let mut downloaded: u64 = 0;
        while let Some(bytes) = stream.try_next().await? {
            if let Some(control) = &control {
                control.wait_if_paused().await;
            }
            writer.write_all(&bytes).await?;
            downloaded = downloaded.saturating_add(bytes.len() as u64);
            if let Some(progress) = &progress {
                progress(downloaded, total);
            }
        }
        writer.flush().await?;
        info!("File {} downloaded successfully.", key);
        Ok(())
    }

    /// Download folder recursively
    pub async fn download_folder(
        config: &DataSource,
        folder_key: &str,
        dest_dir: &str,
        progress: Option<ProgressFn>,
        control: Option<Arc<TransferControl>>,
    ) -> Result<usize> {
        let client = Self::create_client(config).await;
        let mut download_count = 0;
        
        // 确保文件夹路径以 / 结尾
        let prefix = if folder_key.ends_with('/') {
            folder_key.to_string()
        } else {
            format!("{}/", folder_key)
        };
        
        info!("Downloading folder {} to {}", prefix, dest_dir);
        
        // 创建目标目录
        tokio::fs::create_dir_all(dest_dir).await
            .context("Failed to create destination directory")?;
        
        // 列出文件夹内所有对象
        let mut objects: Vec<(String, i64)> = Vec::new();
        let mut continuation_token: Option<String> = None;
        const BATCH_SIZE: i32 = 1000;
        
        loop {
            let mut request = client
                .list_objects_v2()
                .bucket(&config.bucket)
                .prefix(&prefix)
                .max_keys(BATCH_SIZE);
            
            if let Some(token) = continuation_token {
                request = request.continuation_token(token);
            }
            
            let result = request.send().await?;
            
            for obj in result.contents() {
                if let Some(key) = obj.key() {
                    // 跳过文件夹标记对象
                    if !key.ends_with('/') {
                        let size = obj.size().unwrap_or(0);
                        objects.push((key.to_string(), size));
                    }
                }
            }
            
            if result.is_truncated().unwrap_or(false) {
                continuation_token = result.next_continuation_token().map(|s| s.to_string());
            } else {
                break;
            }
        }
        
        // 下载每个文件
        let total_bytes: u64 = objects.iter().map(|(_, size)| *size as u64).sum();
        let downloaded_bytes = Arc::new(std::sync::atomic::AtomicU64::new(0));

        for (key, _size) in objects {
            // 计算相对路径
            let relative_path = key.strip_prefix(&prefix).unwrap_or(&key);
            let file_dest_path = format!("{}/{}", dest_dir, relative_path);
            
            // 创建子目录
            if let Some(parent) = Path::new(&file_dest_path).parent() {
                tokio::fs::create_dir_all(parent).await
                    .context(format!("Failed to create directory for {}", file_dest_path))?;
            }
            
            // 下载文件
            let progress = progress.clone();
            let downloaded_bytes = downloaded_bytes.clone();
            let control = control.clone();
            let file_progress = progress.map(|progress| {
                let last_file_bytes = Arc::new(Mutex::new(0u64));
                Arc::new(move |bytes: u64, _total: Option<u64>| {
                    let mut last = last_file_bytes.lock().unwrap();
                    let delta = bytes.saturating_sub(*last);
                    *last = bytes;
                    let prev = downloaded_bytes.fetch_add(delta, std::sync::atomic::Ordering::Relaxed);
                    let current = prev.saturating_add(delta);
                    progress(current, Some(total_bytes));
                }) as ProgressFn
            });
            match Self::download_file(config, &key, &file_dest_path, file_progress, control).await {
                Ok(_) => {
                    download_count += 1;
                    info!("Downloaded: {}", key);
                }
                Err(e) => {
                    log::error!("Failed to download {}: {}", key, e);
                }
            }
        }
        
        info!("Folder download complete: {} files downloaded", download_count);
        Ok(download_count)
    }

    /// Delete object or folder (recursively)
    pub async fn delete_object(config: &DataSource, key: &str) -> Result<()> {
        let client = Self::create_client(config).await;
        
        // 如果是文件夹（以 / 结尾），需要递归删除所有内容
        if key.ends_with('/') {
            // 先列出该文件夹下的所有对象
            let mut objects_to_delete: Vec<String> = Vec::new();
            
            let mut paginator = client
                .list_objects_v2()
                .bucket(&config.bucket)
                .prefix(key)
                .into_paginator()
                .send();
            
            while let Some(page) = paginator.next().await {
                let page = page?;
                for obj in page.contents() {
                    if let Some(obj_key) = obj.key() {
                        objects_to_delete.push(obj_key.to_string());
                    }
                }
            }
            
            // 批量删除所有对象
            if !objects_to_delete.is_empty() {
                // S3 批量删除每次最多 1000 个对象
                for chunk in objects_to_delete.chunks(1000) {
                    let delete_objects: Vec<_> = chunk
                        .iter()
                        .map(|k| {
                            aws_sdk_s3::types::ObjectIdentifier::builder()
                                .key(k)
                                .build()
                                .expect("Failed to build ObjectIdentifier")
                        })
                        .collect();
                    
                    client
                        .delete_objects()
                        .bucket(&config.bucket)
                        .delete(
                            aws_sdk_s3::types::Delete::builder()
                                .set_objects(Some(delete_objects))
                                .build()
                                .expect("Failed to build Delete"),
                        )
                        .send()
                        .await?;
                }
                
                info!(
                    "Folder and {} objects deleted successfully from {}/{}",
                    objects_to_delete.len(),
                    config.bucket,
                    key
                );
            } else {
                // 文件夹为空，只删除文件夹标记对象
                client
                    .delete_object()
                    .bucket(&config.bucket)
                    .key(key)
                    .send()
                    .await?;
                info!("Empty folder deleted successfully from {}/{}", config.bucket, key);
            }
        } else {
            // 普通文件，直接删除
            client
                .delete_object()
                .bucket(&config.bucket)
                .key(key)
                .send()
                .await?;
            info!("Object deleted successfully from {}/{}", config.bucket, key);
        }
        
        Ok(())
    }

    /// Create folder (upload empty object with trailing slash)
    pub async fn create_folder(config: &DataSource, folder_key: &str) -> Result<()> {
        let client = Self::create_client(config).await;
        let folder_key = if folder_key.ends_with('/') {
            folder_key.to_string()
        } else {
            format!("{}/", folder_key)
        };
        client
            .put_object()
            .bucket(&config.bucket)
            .key(&folder_key)
            .body(ByteStream::from(vec![]))
            .send()
            .await?;
        info!("Folder {} created successfully.", folder_key);
        Ok(())
    }

    /// Copy object
    pub async fn copy_object(
        config: &DataSource,
        src_key: &str,
        dest_key: &str,
    ) -> Result<()> {
        let client = Self::create_client(config).await;
        let encoded_bucket = encode(&config.bucket);
        let encoded_key = encode(src_key);
        let copy_source = format!("{}/{}", encoded_bucket, encoded_key);
        client
            .copy_object()
            .copy_source(copy_source)
            .bucket(&config.bucket)
            .key(dest_key)
            .send()
            .await
            .context("Failed to copy object")?;
        info!(
            "Object copied successfully from {}/{} -> {}/{}",
            config.bucket, src_key, config.bucket, dest_key
        );
        Ok(())
    }

    /// Move object (copy then delete)
    pub async fn move_object(config: &DataSource, src_key: &str, dest_key: &str) -> Result<()> {
        Self::copy_object(config, src_key, dest_key).await?;
        Self::delete_object(config, src_key).await?;
        info!(
            "Object moved successfully from {}/{} -> {}/{}",
            config.bucket, src_key, config.bucket, dest_key
        );
        Ok(())
    }

    /// Get presigned URL for object
    pub async fn get_presigned_url(config: &DataSource, key: &str, expires_in_secs: u64) -> Result<String> {
        let client = Self::create_client(config).await;
        let expires_in = Duration::from_secs(expires_in_secs);
        let presigning_config = PresigningConfig::builder()
            .expires_in(expires_in)
            .build()
            .context("Failed to create presigning config")?;

        let presigned_request = client
            .get_object()
            .bucket(&config.bucket)
            .key(key)
            .presigned(presigning_config)
            .await
            .context("Failed to generate presigned URL")?;

        let url = presigned_request.uri().to_string();
        Ok(url)
    }

    /// Get object metadata
    pub async fn get_object_info(config: &DataSource, key: &str) -> Result<serde_json::Value> {
        let client = Self::create_client(config).await;
        let head = client.head_object().bucket(&config.bucket).key(key).send().await?;

        let mut info = serde_json::json!({
            "key": key,
            "bucket": config.bucket,
        });

        if let Some(size) = head.content_length() {
            info["size"] = serde_json::json!(size);
        }
        if let Some(t) = head.content_type() {
            info["content_type"] = serde_json::json!(t);
        }
        if let Some(t) = head.last_modified() {
            info["last_modified"] = serde_json::json!(t.to_string());
        }
        if let Some(etag) = head.e_tag() {
            info["etag"] = serde_json::json!(etag);
        }

        Ok(info)
    }

    /// Get object content as text (for preview)
    /// Limited to 1MB to avoid memory issues
    pub async fn get_object_content(config: &DataSource, key: &str) -> Result<String> {
        const MAX_SIZE: i64 = 1024 * 1024; // 1MB limit
        
        let client = Self::create_client(config).await;
        
        // First check the size
        let head = client.head_object().bucket(&config.bucket).key(key).send().await?;
        let size = head.content_length().unwrap_or(0);
        
        if size > MAX_SIZE {
            return Err(anyhow::anyhow!(
                "File too large ({} bytes, max {} bytes)", 
                size, MAX_SIZE
            ));
        }
        
        // Get the object content
        let resp = client.get_object().bucket(&config.bucket).key(key).send().await?;
        let data = resp.body.collect().await?;
        let bytes = data.into_bytes();
        
        // Try to convert to UTF-8 string
        match String::from_utf8(bytes.to_vec()) {
            Ok(text) => {
                info!("Object content loaded for {}/{} ({} chars)", config.bucket, key, text.len());
                Ok(text)
            }
            Err(_) => Err(anyhow::anyhow!("File is not valid UTF-8 text")),
        }
    }

    /// Get bucket location/region
    pub async fn get_bucket_location(config: &DataSource) -> Result<String> {
        let client = Self::create_client(config).await;
        let location_resp = client.get_bucket_location().bucket(&config.bucket).send().await?;
        let region = location_resp
            .location_constraint()
            .map(|r: &aws_sdk_s3::types::BucketLocationConstraint| r.as_str())
            .unwrap_or("us-east-1");
        Ok(region.to_string())
    }

    /// Validates that a key is valid for S3 operations
    pub fn validate_key(key: &str) -> Result<(), String> {
        if key.is_empty() {
            return Err("Key cannot be empty".to_string());
        }
        if key.len() > 1024 {
            return Err("Key cannot exceed 1024 characters".to_string());
        }
        Ok(())
    }

    /// Validates bucket name according to S3 rules
    pub fn validate_bucket_name(name: &str) -> Result<(), String> {
        if name.len() < 3 || name.len() > 63 {
            return Err("Bucket name must be between 3 and 63 characters".to_string());
        }
        if name.contains("..") {
            return Err("Bucket name cannot contain consecutive periods".to_string());
        }
        if name.starts_with('.') || name.ends_with('.') {
            return Err("Bucket name cannot start or end with a period".to_string());
        }
        if !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-') {
            return Err("Bucket name can only contain lowercase letters, numbers, periods, and hyphens".to_string());
        }
        Ok(())
    }

    /// Normalize folder key to ensure it ends with /
    pub fn normalize_folder_key(key: &str) -> String {
        if key.ends_with('/') {
            key.to_string()
        } else {
            format!("{}/", key)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_manager::DataSourceConfig;

    fn create_test_data_source() -> DataSourceConfig {
        DataSourceConfig::new(
            "test-id".to_string(),
            "Test Source".to_string(),
            "test-bucket".to_string(),
            "us-east-1".to_string(),
            "test-access-key".to_string(),
            "test-secret-key".to_string(),
            "https://s3.test.com".to_string(),
        )
    }

    #[test]
    fn test_s3_client_config_new() {
        let config = S3ClientConfig::new(
            "access_key".to_string(),
            "secret_key".to_string(),
            "https://s3.test.com".to_string(),
        );
        assert_eq!(config.access_key, "access_key");
        assert_eq!(config.secret_key, "secret_key");
        assert_eq!(config.endpoint, "https://s3.test.com");
    }

    #[test]
    fn test_bucket_info_creation() {
        let info = BucketInfo {
            name: "my-bucket".to_string(),
            size: Some("100MB".to_string()),
        };
        assert_eq!(info.name, "my-bucket");
        assert_eq!(info.size, Some("100MB".to_string()));
    }

    #[test]
    fn test_object_info_creation() {
        let info = ObjectInfo {
            key: "test/file.txt".to_string(),
            size: Some(1024),
            last_modified: Some("2024-01-01".to_string()),
            is_folder: false,
        };
        assert_eq!(info.key, "test/file.txt");
        assert_eq!(info.size, Some(1024));
        assert_eq!(info.is_folder, false);
    }

    #[test]
    fn test_object_info_folder() {
        let info = ObjectInfo {
            key: "test/folder/".to_string(),
            size: None,
            last_modified: None,
            is_folder: true,
        };
        assert!(info.is_folder);
        assert!(info.size.is_none());
    }

    #[test]
    fn test_validate_key_empty() {
        let result = S3Operations::validate_key("");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("empty"));
    }

    #[test]
    fn test_validate_key_too_long() {
        let long_key = "a".repeat(1025);
        let result = S3Operations::validate_key(&long_key);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("1024"));
    }

    #[test]
    fn test_validate_key_valid() {
        let result = S3Operations::validate_key("valid/key.txt");
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_bucket_name_too_short() {
        let result = S3Operations::validate_bucket_name("ab");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("3 and 63"));
    }

    #[test]
    fn test_validate_bucket_name_too_long() {
        let long_name = "a".repeat(64);
        let result = S3Operations::validate_bucket_name(&long_name);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_bucket_name_consecutive_periods() {
        let result = S3Operations::validate_bucket_name("test..bucket");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("consecutive periods"));
    }

    #[test]
    fn test_validate_bucket_name_starting_period() {
        let result = S3Operations::validate_bucket_name(".testbucket");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("start or end"));
    }

    #[test]
    fn test_validate_bucket_name_ending_period() {
        let result = S3Operations::validate_bucket_name("testbucket.");
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_bucket_name_uppercase() {
        let result = S3Operations::validate_bucket_name("TestBucket");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("lowercase"));
    }

    #[test]
    fn test_validate_bucket_name_valid() {
        let result = S3Operations::validate_bucket_name("my-test-bucket");
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_bucket_name_with_numbers() {
        let result = S3Operations::validate_bucket_name("my-bucket-123");
        assert!(result.is_ok());
    }

    #[test]
    fn test_normalize_folder_key_with_slash() {
        let result = S3Operations::normalize_folder_key("folder/");
        assert_eq!(result, "folder/");
    }

    #[test]
    fn test_normalize_folder_key_without_slash() {
        let result = S3Operations::normalize_folder_key("folder");
        assert_eq!(result, "folder/");
    }

    #[test]
    fn test_normalize_folder_key_empty() {
        let result = S3Operations::normalize_folder_key("");
        assert_eq!(result, "/");
    }

    #[test]
    fn test_normalize_folder_key_nested() {
        let result = S3Operations::normalize_folder_key("path/to/folder");
        assert_eq!(result, "path/to/folder/");
    }

    #[test]
    fn test_constants() {
        assert_eq!(DEFAULT_REGION, "us-east-1");
        assert_eq!(MAX_CONCURRENT_TASKS, 50);
        assert_eq!(CHUNK_SIZE, 10 * 1024 * 1024);
    }
}
