// Data source configuration storage
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DataSourceConfig {
    pub id: String,
    pub name: String,
    pub bucket: String,
    pub region: String,
    pub access_key: String,
    pub secret_key: String,
    pub endpoint: String,
    pub path_endpoint: Option<String>,
}

impl DataSourceConfig {
    pub fn new(
        id: String,
        name: String,
        bucket: String,
        region: String,
        access_key: String,
        secret_key: String,
        endpoint: String,
    ) -> Self {
        Self {
            id,
            name,
            bucket,
            region,
            access_key,
            secret_key,
            endpoint,
            path_endpoint: None,
        }
    }
}

// Re-export DataSourceConfig as DataSource for compatibility
pub type DataSource = DataSourceConfig;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct AppConfig {
    pub data_sources: Vec<DataSourceConfig>,
    pub last_used_source: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            data_sources: Vec::new(),
            last_used_source: None,
        }
    }
}

pub struct ConfigManager {
    config_path: Option<PathBuf>,
}

impl Default for ConfigManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ConfigManager {
    pub fn new() -> Self {
        Self { config_path: None }
    }

    /// Create a ConfigManager with a custom config path (for testing)
    pub fn with_config_path(path: PathBuf) -> Self {
        Self {
            config_path: Some(path),
        }
    }

    /// 获取配置文件路径
    /// 统一使用 ~/.config/s3-client-app/config.json (Linux/macOS/Windows)
    fn get_config_path(&self) -> PathBuf {
        if let Some(ref path) = self.config_path {
            return path.clone();
        }

        // 强制使用 ~/.config/s3-client-app/config.json
        // 在 macOS 上不使用 ~/Library/Application Support
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".config")
            .join("s3-client-app")
            .join("config.json")
    }

    pub fn load_config(&self) -> Result<AppConfig, String> {
        let config_path = self.get_config_path();

        // 配置文件不存在时返回默认配置（首次启动场景）
        if !config_path.exists() {
            return Ok(AppConfig::default());
        }

        let content = fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;

        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config: {}", e))
    }

    pub fn save_config(&self, config: &AppConfig) -> Result<(), String> {
        let config_path = self.get_config_path();
        
        // Ensure parent directory exists
        if let Some(parent) = config_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create config directory: {}", e))?;
            }
        }
        
        let content = serde_json::to_string_pretty(config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;

        fs::write(&config_path, content)
            .map_err(|e| format!("Failed to write config: {}", e))?;

        Ok(())
    }

    pub fn add_data_source(&self, source: DataSourceConfig) -> Result<(), String> {
        let mut config = self.load_config()?;

        // Check if source with same name exists
        if config.data_sources.iter().any(|s| s.name == source.name) {
            return Err("A data source with this name already exists".to_string());
        }

        // Check if source with same id exists
        if config.data_sources.iter().any(|s| s.id == source.id) {
            return Err("A data source with this ID already exists".to_string());
        }

        config.data_sources.push(source);
        self.save_config(&config)?;
        Ok(())
    }

    pub fn update_data_source(&self, source: DataSourceConfig) -> Result<(), String> {
        let mut config = self.load_config()?;

        let mut found = false;
        for s in config.data_sources.iter_mut() {
            if s.id == source.id {
                *s = source;
                found = true;
                break;
            }
        }

        if !found {
            return Err("Data source not found".to_string());
        }

        self.save_config(&config)?;
        Ok(())
    }

    pub fn delete_data_source(&self, id: &str) -> Result<(), String> {
        let mut config = self.load_config()?;

        let original_len = config.data_sources.len();
        config.data_sources.retain(|s| s.id != id);

        if config.data_sources.len() == original_len {
            return Err("Data source not found".to_string());
        }

        if config.last_used_source.as_deref() == Some(id) {
            config.last_used_source = None;
        }

        self.save_config(&config)?;
        Ok(())
    }

    pub fn get_data_source(&self, id: &str) -> Result<Option<DataSourceConfig>, String> {
        let config = self.load_config()?;
        Ok(config.data_sources.iter().find(|s| s.id == id).cloned())
    }

    pub fn get_all_data_sources(&self) -> Result<Vec<DataSourceConfig>, String> {
        let config = self.load_config()?;
        Ok(config.data_sources)
    }

    pub fn set_last_used_source(&self, id: &str) -> Result<(), String> {
        let mut config = self.load_config()?;
        
        // Verify the data source exists
        if !config.data_sources.iter().any(|s| s.id == id) {
            return Err("Data source not found".to_string());
        }
        
        config.last_used_source = Some(id.to_string());
        self.save_config(&config)?;
        Ok(())
    }

    pub fn get_last_used_source(&self) -> Result<Option<DataSourceConfig>, String> {
        let config = self.load_config()?;
        Ok(config
            .last_used_source
            .and_then(|id| config.data_sources.iter().find(|s| s.id == id).cloned()))
    }

    /// Clear all data sources (for testing)
    #[cfg(test)]
    pub fn clear_all(&self) -> Result<(), String> {
        let config = AppConfig::default();
        self.save_config(&config)?;
        Ok(())
    }
}

// Static methods for backward compatibility (uses default config path)
pub struct ConfigManagerStatic;

impl ConfigManagerStatic {
    fn get_manager() -> ConfigManager {
        ConfigManager::new()
    }

    pub fn load_config() -> Result<AppConfig, String> {
        Self::get_manager().load_config()
    }

    pub fn save_config(config: &AppConfig) -> Result<(), String> {
        Self::get_manager().save_config(config)
    }

    pub fn add_data_source(source: DataSourceConfig) -> Result<(), String> {
        Self::get_manager().add_data_source(source)
    }

    pub fn update_data_source(source: DataSourceConfig) -> Result<(), String> {
        Self::get_manager().update_data_source(source)
    }

    pub fn delete_data_source(id: &str) -> Result<(), String> {
        Self::get_manager().delete_data_source(id)
    }

    pub fn get_data_source(id: &str) -> Result<Option<DataSourceConfig>, String> {
        Self::get_manager().get_data_source(id)
    }

    pub fn get_all_data_sources() -> Result<Vec<DataSourceConfig>, String> {
        Self::get_manager().get_all_data_sources()
    }

    pub fn set_last_used_source(id: &str) -> Result<(), String> {
        Self::get_manager().set_last_used_source(id)
    }

    pub fn get_last_used_source() -> Result<Option<DataSourceConfig>, String> {
        Self::get_manager().get_last_used_source()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_manager() -> (ConfigManager, PathBuf, tempfile::TempDir) {
        let temp_dir = tempfile::tempdir().expect("Failed to create temp dir");
        let config_path = temp_dir.path().join("test_config.json");
        let manager = ConfigManager::with_config_path(config_path.clone());
        (manager, config_path, temp_dir)
    }

    fn create_test_data_source(id: &str, name: &str) -> DataSourceConfig {
        DataSourceConfig::new(
            id.to_string(),
            name.to_string(),
            "test-bucket".to_string(),
            "us-east-1".to_string(),
            "test-access-key".to_string(),
            "test-secret-key".to_string(),
            "https://s3.test.com".to_string(),
        )
    }

    #[test]
    fn test_load_config_empty() {
        let (manager, _, _temp) = create_test_manager();
        let config = manager.load_config().unwrap();
        assert!(config.data_sources.is_empty());
        assert!(config.last_used_source.is_none());
    }

    #[test]
    fn test_add_data_source() {
        let (manager, _, _temp) = create_test_manager();
        let source = create_test_data_source("1", "Test Source");

        manager.add_data_source(source.clone()).unwrap();

        let config = manager.load_config().unwrap();
        assert_eq!(config.data_sources.len(), 1);
        assert_eq!(config.data_sources[0].name, "Test Source");
    }

    #[test]
    fn test_add_duplicate_name_fails() {
        let (manager, _, _temp) = create_test_manager();
        let source1 = create_test_data_source("1", "Test Source");
        let source2 = create_test_data_source("2", "Test Source");

        manager.add_data_source(source1).unwrap();
        let result = manager.add_data_source(source2);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("name already exists"));
    }

    #[test]
    fn test_add_duplicate_id_fails() {
        let (manager, _, _temp) = create_test_manager();
        let source1 = create_test_data_source("1", "Test Source 1");
        let source2 = create_test_data_source("1", "Test Source 2");

        manager.add_data_source(source1).unwrap();
        let result = manager.add_data_source(source2);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("ID already exists"));
    }

    #[test]
    fn test_get_data_source() {
        let (manager, _, _temp) = create_test_manager();
        let source = create_test_data_source("1", "Test Source");
        manager.add_data_source(source.clone()).unwrap();

        let found = manager.get_data_source("1").unwrap();
        assert!(found.is_some());
        assert_eq!(found.unwrap().name, "Test Source");

        let not_found = manager.get_data_source("999").unwrap();
        assert!(not_found.is_none());
    }

    #[test]
    fn test_get_all_data_sources() {
        let (manager, _, _temp) = create_test_manager();
        let source1 = create_test_data_source("1", "Source 1");
        let source2 = create_test_data_source("2", "Source 2");

        manager.add_data_source(source1).unwrap();
        manager.add_data_source(source2).unwrap();

        let sources = manager.get_all_data_sources().unwrap();
        assert_eq!(sources.len(), 2);
    }

    #[test]
    fn test_update_data_source() {
        let (manager, _, _temp) = create_test_manager();
        let source = create_test_data_source("1", "Original Name");
        manager.add_data_source(source).unwrap();

        let updated = create_test_data_source("1", "Updated Name");
        manager.update_data_source(updated).unwrap();

        let found = manager.get_data_source("1").unwrap();
        assert_eq!(found.unwrap().name, "Updated Name");
    }

    #[test]
    fn test_update_nonexistent_fails() {
        let (manager, _, _temp) = create_test_manager();
        let source = create_test_data_source("999", "Nonexistent");

        let result = manager.update_data_source(source);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_delete_data_source() {
        let (manager, _, _temp) = create_test_manager();
        let source = create_test_data_source("1", "Test Source");
        manager.add_data_source(source).unwrap();

        manager.delete_data_source("1").unwrap();

        let sources = manager.get_all_data_sources().unwrap();
        assert!(sources.is_empty());
    }

    #[test]
    fn test_delete_nonexistent_fails() {
        let (manager, _, _temp) = create_test_manager();

        let result = manager.delete_data_source("999");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_delete_clears_last_used() {
        let (manager, _, _temp) = create_test_manager();
        let source = create_test_data_source("1", "Test Source");
        manager.add_data_source(source).unwrap();
        manager.set_last_used_source("1").unwrap();

        manager.delete_data_source("1").unwrap();

        let config = manager.load_config().unwrap();
        assert!(config.last_used_source.is_none());
    }

    #[test]
    fn test_set_last_used_source() {
        let (manager, _, _temp) = create_test_manager();
        let source = create_test_data_source("1", "Test Source");
        manager.add_data_source(source).unwrap();

        manager.set_last_used_source("1").unwrap();

        let last_used = manager.get_last_used_source().unwrap();
        assert!(last_used.is_some());
        assert_eq!(last_used.unwrap().id, "1");
    }

    #[test]
    fn test_set_last_used_nonexistent_fails() {
        let (manager, _, _temp) = create_test_manager();

        let result = manager.set_last_used_source("999");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn test_get_last_used_source_none() {
        let (manager, _, _temp) = create_test_manager();

        let last_used = manager.get_last_used_source().unwrap();
        assert!(last_used.is_none());
    }

    #[test]
    fn test_get_last_used_source_deleted() {
        let (manager, _, _temp) = create_test_manager();
        let source = create_test_data_source("1", "Test Source");
        manager.add_data_source(source).unwrap();
        manager.set_last_used_source("1").unwrap();

        // Manually delete the source and set last_used to it
        let mut config = manager.load_config().unwrap();
        config.data_sources.clear();
        manager.save_config(&config).unwrap();

        // Reset last_used to deleted id for test
        let mut config = manager.load_config().unwrap();
        config.last_used_source = Some("1".to_string());
        manager.save_config(&config).unwrap();

        let last_used = manager.get_last_used_source().unwrap();
        assert!(last_used.is_none());
    }

    #[test]
    fn test_config_persistence() {
        let (manager, config_path, _temp) = create_test_manager();
        let source = create_test_data_source("1", "Test Source");
        manager.add_data_source(source).unwrap();

        // Create a new manager pointing to the same file
        let manager2 = ConfigManager::with_config_path(config_path);
        let sources = manager2.get_all_data_sources().unwrap();

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].name, "Test Source");
    }

    #[test]
    fn test_save_and_load_config() {
        let (manager, _, _temp) = create_test_manager();
        let config = AppConfig {
            data_sources: vec![create_test_data_source("1", "Test")],
            last_used_source: Some("1".to_string()),
        };

        manager.save_config(&config).unwrap();
        let loaded = manager.load_config().unwrap();

        assert_eq!(loaded, config);
    }
}
