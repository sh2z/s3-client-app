#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod config_manager;
mod s3_client;

use crate::config_manager::{ConfigManagerStatic as ConfigManager, DataSourceConfig};
use crate::s3_client::{
    S3Operations,
    get_or_create_transfer_control,
    remove_transfer_control,
    pause_transfer as s3_pause_transfer,
    resume_transfer as s3_resume_transfer,
};
use serde::{Deserialize, Serialize};
use tauri::Emitter;
use std::sync::Arc;


#[derive(Serialize, Deserialize, Debug)]
pub struct AddDataSourceRequest {
    name: String,
    bucket: String,
    region: String,
    access_key: String,
    secret_key: String,
    endpoint: String,
    path_endpoint: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RenameRequest {
    old_key: String,
    new_key: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SelectedFile {
    path: String,
    name: String,
    size: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TransferEvent {
    id: String,
    direction: String,
    key: String,
    bytes: u64,
    total: Option<u64>,
    status: String,
    message: Option<String>,
}

#[tauri::command]
async fn get_data_sources() -> Result<Vec<DataSourceConfig>, String> {
    ConfigManager::get_all_data_sources()
}

#[tauri::command]
async fn add_data_source(request: AddDataSourceRequest) -> Result<DataSourceConfig, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let mut source = DataSourceConfig::new(
        id,
        request.name,
        request.bucket,
        request.region,
        request.access_key,
        request.secret_key,
        request.endpoint,
    );
    source.path_endpoint = request.path_endpoint;
    
    ConfigManager::add_data_source(source.clone())?;
    Ok(source)
}

#[tauri::command]
async fn update_data_source(source: DataSourceConfig) -> Result<(), String> {
    ConfigManager::update_data_source(source)?;
    Ok(())
}

#[tauri::command]
async fn delete_data_source(id: String) -> Result<(), String> {
    ConfigManager::delete_data_source(&id)?;
    Ok(())
}

#[tauri::command]
async fn list_buckets(config: DataSourceConfig) -> Result<Vec<String>, String> {
    S3Operations::list_buckets(&config).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn warm_up_connection(config: DataSourceConfig) -> Result<(), String> {
    S3Operations::warm_up_connection(&config).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_objects(
    config: DataSourceConfig,
    prefix: String,
    continuation_token: Option<String>,
    batch_size: Option<i32>,
) -> Result<s3_client::ListObjectsResponse, String> {
    S3Operations::list_objects(&config, &prefix, continuation_token, batch_size)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn search_objects(
    config: DataSourceConfig,
    query: String,
) -> Result<s3_client::ListObjectsResponse, String> {
    S3Operations::search_objects(&config, &query)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_bucket_total_size(config: DataSourceConfig) -> Result<i64, String> {
    S3Operations::get_bucket_total_size(&config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn upload_file(
    app: tauri::AppHandle,
    config: DataSourceConfig,
    local_path: Vec<u8>,
    key: String,
    transferId: String,
) -> Result<(), String> {
    let transfer_id = transferId.clone();
    let control = get_or_create_transfer_control(&transferId);
    let start_event = TransferEvent {
        id: transferId.clone(),
        direction: "upload".to_string(),
        key: key.clone(),
        bytes: 0,
        total: Some(local_path.len() as u64),
        status: "started".to_string(),
        message: None,
    };
    let _ = app.emit("transfer:progress", start_event);
    let app_handle = app.clone();
    let key_clone = key.clone();
    let transfer_id_clone = transferId.clone();
    let progress = Arc::new(move |bytes: u64, total: Option<u64>| {
        let event = TransferEvent {
            id: transfer_id_clone.clone(),
            direction: "upload".to_string(),
            key: key_clone.clone(),
            bytes,
            total,
            status: "progress".to_string(),
            message: None,
        };
        let _ = app_handle.emit("transfer:progress", event);
    });
    let result = S3Operations::upload_file_bytes(&config, &local_path, &key, Some(progress), Some(control))
        .await
        .map_err(|e| e.to_string());
    match &result {
        Ok(_) => {
            let done_event = TransferEvent {
                id: transfer_id.clone(),
                direction: "upload".to_string(),
                key,
                bytes: local_path.len() as u64,
                total: Some(local_path.len() as u64),
                status: "completed".to_string(),
                message: None,
            };
            let _ = app.emit("transfer:progress", done_event);
        }
        Err(error) => {
            let fail_event = TransferEvent {
                id: transfer_id.clone(),
                direction: "upload".to_string(),
                key,
                bytes: 0,
                total: Some(local_path.len() as u64),
                status: "failed".to_string(),
                message: Some(error.clone()),
            };
            let _ = app.emit("transfer:progress", fail_event);
        }
    }
    remove_transfer_control(&transferId);
    result
}

#[tauri::command]
async fn upload_file_from_path(
    app: tauri::AppHandle,
    config: DataSourceConfig,
    localPath: String,
    key: String,
    transferId: String,
) -> Result<(), String> {
    // Validate config
    if config.access_key.is_empty() || config.secret_key.is_empty() {
        return Err("数据源缺少访问凭证".to_string());
    }
    if config.bucket.is_empty() {
        return Err("数据源缺少桶名称".to_string());
    }
    if config.endpoint.is_empty() {
        return Err("数据源缺少端点地址".to_string());
    }

    let transfer_id = transferId.clone();
    let metadata = tokio::fs::metadata(&localPath)
        .await
        .map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        return Err("选中的路径是文件夹，暂不支持拖拽上传文件夹".to_string());
    }
    let total = Some(metadata.len());
    let control = get_or_create_transfer_control(&transferId);
    let start_event = TransferEvent {
        id: transferId.clone(),
        direction: "upload".to_string(),
        key: key.clone(),
        bytes: 0,
        total,
        status: "started".to_string(),
        message: None,
    };
    let _ = app.emit("transfer:progress", start_event);
    let app_handle = app.clone();
    let key_clone = key.clone();
    let transfer_id_clone = transferId.clone();
    let progress = Arc::new(move |bytes: u64, total: Option<u64>| {
        let event = TransferEvent {
            id: transfer_id_clone.clone(),
            direction: "upload".to_string(),
            key: key_clone.clone(),
            bytes,
            total,
            status: "progress".to_string(),
            message: None,
        };
        let _ = app_handle.emit("transfer:progress", event);
    });
    let result = S3Operations::upload_file(&config, &localPath, &key, Some(progress), Some(control))
        .await
        .map_err(|e| e.to_string());
    match &result {
        Ok(_) => {
            let done_event = TransferEvent {
                id: transfer_id.clone(),
                direction: "upload".to_string(),
                key,
                bytes: total.unwrap_or(0),
                total,
                status: "completed".to_string(),
                message: None,
            };
            let _ = app.emit("transfer:progress", done_event);
        }
        Err(error) => {
            let fail_event = TransferEvent {
                id: transfer_id.clone(),
                direction: "upload".to_string(),
                key,
                bytes: 0,
                total,
                status: "failed".to_string(),
                message: Some(error.clone()),
            };
            let _ = app.emit("transfer:progress", fail_event);
        }
    }
    remove_transfer_control(&transferId);
    result
}

#[tauri::command]
async fn download_file(
    app: tauri::AppHandle,
    config: DataSourceConfig,
    key: String,
    destPath: String,
    transferId: String,
) -> Result<(), String> {
    let transfer_id = transferId.clone();
    let control = get_or_create_transfer_control(&transferId);
    let start_event = TransferEvent {
        id: transferId.clone(),
        direction: "download".to_string(),
        key: key.clone(),
        bytes: 0,
        total: None,
        status: "started".to_string(),
        message: None,
    };
    let _ = app.emit("transfer:progress", start_event);
    let app_handle = app.clone();
    let key_clone = key.clone();
    let transfer_id_clone = transferId.clone();
    let progress = Arc::new(move |bytes: u64, total: Option<u64>| {
        let event = TransferEvent {
            id: transfer_id_clone.clone(),
            direction: "download".to_string(),
            key: key_clone.clone(),
            bytes,
            total,
            status: "progress".to_string(),
            message: None,
        };
        let _ = app_handle.emit("transfer:progress", event);
    });
    let result = S3Operations::download_file(&config, &key, &destPath, Some(progress), Some(control))
        .await
        .map_err(|e| e.to_string());
    match &result {
        Ok(_) => {
            let done_event = TransferEvent {
                id: transfer_id.clone(),
                direction: "download".to_string(),
                key,
                bytes: 0,
                total: None,
                status: "completed".to_string(),
                message: None,
            };
            let _ = app.emit("transfer:progress", done_event);
        }
        Err(error) => {
            let fail_event = TransferEvent {
                id: transfer_id.clone(),
                direction: "download".to_string(),
                key,
                bytes: 0,
                total: None,
                status: "failed".to_string(),
                message: Some(error.clone()),
            };
            let _ = app.emit("transfer:progress", fail_event);
        }
    }
    remove_transfer_control(&transferId);
    result
}

#[tauri::command]
async fn download_folder(
    app: tauri::AppHandle,
    config: DataSourceConfig,
    folder_key: String,
    dest_dir: String,
    transferId: String,
) -> Result<usize, String> {
    let transfer_id = transferId.clone();
    let control = get_or_create_transfer_control(&transferId);
    let start_event = TransferEvent {
        id: transferId.clone(),
        direction: "download".to_string(),
        key: folder_key.clone(),
        bytes: 0,
        total: None,
        status: "started".to_string(),
        message: None,
    };
    let _ = app.emit("transfer:progress", start_event);
    let app_handle = app.clone();
    let key_clone = folder_key.clone();
    let transfer_id_clone = transferId.clone();
    let progress = Arc::new(move |bytes: u64, total: Option<u64>| {
        let event = TransferEvent {
            id: transfer_id_clone.clone(),
            direction: "download".to_string(),
            key: key_clone.clone(),
            bytes,
            total,
            status: "progress".to_string(),
            message: None,
        };
        let _ = app_handle.emit("transfer:progress", event);
    });
    let result = S3Operations::download_folder(&config, &folder_key, &dest_dir, Some(progress), Some(control))
        .await
        .map_err(|e| e.to_string());
    match &result {
        Ok(_) => {
            let done_event = TransferEvent {
                id: transfer_id.clone(),
                direction: "download".to_string(),
                key: folder_key,
                bytes: 0,
                total: None,
                status: "completed".to_string(),
                message: None,
            };
            let _ = app.emit("transfer:progress", done_event);
        }
        Err(error) => {
            let fail_event = TransferEvent {
                id: transfer_id.clone(),
                direction: "download".to_string(),
                key: folder_key,
                bytes: 0,
                total: None,
                status: "failed".to_string(),
                message: Some(error.clone()),
            };
            let _ = app.emit("transfer:progress", fail_event);
        }
    }
    remove_transfer_control(&transferId);
    result
}

#[tauri::command]
async fn pause_transfer(app: tauri::AppHandle, transferId: String) -> Result<(), String> {
    if !s3_pause_transfer(&transferId) {
        return Err("transfer not found".to_string());
    }
    let event = TransferEvent {
        id: transferId,
        direction: "unknown".to_string(),
        key: "".to_string(),
        bytes: 0,
        total: None,
        status: "paused".to_string(),
        message: None,
    };
    let _ = app.emit("transfer:progress", event);
    Ok(())
}

#[tauri::command]
async fn resume_transfer(app: tauri::AppHandle, transferId: String) -> Result<(), String> {
    if !s3_resume_transfer(&transferId) {
        return Err("transfer not found".to_string());
    }
    let event = TransferEvent {
        id: transferId,
        direction: "unknown".to_string(),
        key: "".to_string(),
        bytes: 0,
        total: None,
        status: "resumed".to_string(),
        message: None,
    };
    let _ = app.emit("transfer:progress", event);
    Ok(())
}

#[tauri::command]
async fn delete_object(config: DataSourceConfig, key: String) -> Result<(), String> {
    S3Operations::delete_object(&config, &key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_folder(config: DataSourceConfig, folderKey: String) -> Result<(), String> {
    S3Operations::create_folder(&config, &folderKey)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_object(
    config: DataSourceConfig,
    oldKey: String,
    newKey: String,
) -> Result<(), String> {
    S3Operations::move_object(&config, &oldKey, &newKey)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_presigned_url(
    config: DataSourceConfig,
    key: String,
    expires_in_secs: u64,
) -> Result<String, String> {
    S3Operations::get_presigned_url(&config, &key, expires_in_secs)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_object_info(
    config: DataSourceConfig,
    key: String,
) -> Result<serde_json::Value, String> {
    S3Operations::get_object_info(&config, &key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_object_content(
    config: DataSourceConfig,
    key: String,
) -> Result<String, String> {
    S3Operations::get_object_content(&config, &key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn select_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    
    let result = app
        .dialog()
        .file()
        .blocking_pick_folder();
    
    Ok(result.map(|p| p.to_string()))
}

#[tauri::command]
async fn select_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    
    let result = app
        .dialog()
        .file()
        .blocking_pick_file();
    
    Ok(result.map(|p| p.to_string()))
}

#[tauri::command]
async fn select_files(app: tauri::AppHandle) -> Result<Option<Vec<SelectedFile>>, String> {
    use tauri_plugin_dialog::DialogExt;
    use std::path::Path;

    let result = app
        .dialog()
        .file()
        .blocking_pick_files();

    let Some(paths) = result else {
        return Ok(None);
    };

    let mut files = Vec::new();
    for path in paths {
        let path_str = path.to_string();
        let name = Path::new(&path_str)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let size = tokio::fs::metadata(&path_str)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        files.push(SelectedFile { path: path_str, name, size });
    }

    Ok(Some(files))
}

#[tauri::command]
async fn select_save_location(app: tauri::AppHandle, defaultName: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;
    
    let (tx, rx) = oneshot::channel();
    
    app.dialog()
        .file()
        .set_file_name(&defaultName)
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    
    let result = rx.await.map_err(|e| e.to_string())?;
    Ok(result.map(|p| p.to_string()))
}

#[tauri::command]
async fn read_local_file(file_path: String) -> Result<Vec<u8>, String> {
    use tokio::fs;
    fs::read(&file_path).await.map_err(|e| format!("Failed to read file: {}", e))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_data_sources,
            add_data_source,
            update_data_source,
            delete_data_source,
            list_buckets,
            list_objects,
            search_objects,
            get_bucket_total_size,
            upload_file,
            upload_file_from_path,
            download_file,
            download_folder,
            delete_object,
            create_folder,
            rename_object,
            get_presigned_url,
            get_object_info,
            get_object_content,
            warm_up_connection,
            read_local_file,
            select_directory,
            select_file,
            select_files,
            select_save_location,
            pause_transfer,
            resume_transfer,
        ])
        // 通过前端 HTML5 + Tauri DragDrop 事件协作处理拖拽
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
