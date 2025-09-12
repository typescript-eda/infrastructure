/**
 * Configuration Manager - Centralized configuration management for all system components
 * Handles environment variables, config files, validation, and dynamic updates
 */

const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');

class ConfigurationManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.logger = options.logger || console;
    this.configDir = options.configDir || './config';
    this.environment = options.environment || process.env.NODE_ENV || 'development';
    this.watchForChanges = options.watchForChanges !== false;
    
    // Configuration storage
    this.config = {};
    this.schema = {};
    this.watchers = new Map();
    
    // Default configuration structure
    this.defaultConfig = {
      server: {
        ports: {
          http: 8080,
          websocket: 8081,
          extension: 8082
        },
        host: 'localhost',
        timeout: 30000,
        cors: {
          enabled: true,
          origins: ['*']
        }
      },
      database: {
        events: {
          path: './data/events',
          snapshotFrequency: 100
        },
        snapshots: {
          path: './data/snapshots'
        }
      },
      browser: {
        automation: {
          timeout: 60000,
          retries: 3,
          headless: true
        },
        extension: {
          timeout: 30000,
          reconnectDelay: 5000
        },
        playwright: {
          browser: 'chromium',
          viewport: { width: 1920, height: 1080 },
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      },
      retry: {
        maxRetries: 3,
        baseDelay: 1000,
        maxDelay: 30000,
        backoffFactor: 2,
        jitter: true
      },
      circuitBreaker: {
        failureThreshold: 5,
        recoveryTimeout: 60000,
        monitoringPeriod: 10000
      },
      monitoring: {
        enabled: true,
        metricsInterval: 30000,
        alertThresholds: {
          errorRate: 0.1,
          responseTime: 5000,
          memoryUsage: 0.8
        }
      },
      logging: {
        level: 'info',
        format: 'json',
        destination: 'console',
        rotation: {
          enabled: false,
          maxSize: '100MB',
          maxFiles: 10
        }
      },
      security: {
        authentication: {
          enabled: false,
          tokenExpiry: 3600
        },
        rateLimit: {
          enabled: true,
          windowMs: 60000,
          maxRequests: 100
        }
      }
    };
    
    // Configuration schema for validation
    this.configSchema = {
      server: {
        ports: {
          http: { type: 'number', min: 1, max: 65535 },
          websocket: { type: 'number', min: 1, max: 65535 },
          extension: { type: 'number', min: 1, max: 65535 }
        },
        host: { type: 'string', required: true },
        timeout: { type: 'number', min: 1000 }
      },
      browser: {
        automation: {
          timeout: { type: 'number', min: 1000 },
          retries: { type: 'number', min: 0, max: 10 },
          headless: { type: 'boolean' }
        }
      },
      retry: {
        maxRetries: { type: 'number', min: 0, max: 10 },
        baseDelay: { type: 'number', min: 100 },
        backoffFactor: { type: 'number', min: 1 }
      },
      monitoring: {
        metricsInterval: { type: 'number', min: 1000 },
        alertThresholds: {
          errorRate: { type: 'number', min: 0, max: 1 },
          responseTime: { type: 'number', min: 100 },
          memoryUsage: { type: 'number', min: 0, max: 1 }
        }
      }
    };
  }

  /**
   * Initialize configuration manager
   */
  async initialize() {
    try {
      // Load default configuration
      this.config = this.deepClone(this.defaultConfig);
      
      // Load environment-specific configuration
      await this.loadEnvironmentConfig();
      
      // Apply environment variables
      this.applyEnvironmentVariables();
      
      // Validate configuration
      this.validateConfiguration();
      
      // Setup file watchers if enabled
      if (this.watchForChanges) {
        await this.setupFileWatchers();
      }
      
      this.logger.info(`Configuration manager initialized for environment: ${this.environment}`);
      this.emit('initialized', this.config);
      
    } catch (error) {
      this.logger.error('Failed to initialize configuration manager:', error);
      throw error;
    }
  }

  /**
   * Load environment-specific configuration files
   */
  async loadEnvironmentConfig() {
    const configFiles = [
      'config.json',
      `config.${this.environment}.json`,
      'local.json'
    ];
    
    for (const configFile of configFiles) {
      await this.loadConfigFile(configFile);
    }
  }

  /**
   * Load a specific configuration file
   */
  async loadConfigFile(filename) {
    try {
      const configPath = path.join(this.configDir, filename);
      
      // Check if file exists
      await fs.access(configPath);
      
      const configContent = await fs.readFile(configPath, 'utf-8');
      const configData = JSON.parse(configContent);
      
      // Merge with existing configuration
      this.config = this.deepMerge(this.config, configData);
      
      this.logger.debug(`Loaded configuration from: ${filename}`);
      
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.warn(`Error loading config file ${filename}:`, error.message);
      }
    }
  }

  /**
   * Apply environment variables to configuration
   */
  applyEnvironmentVariables() {
    const envMappings = {
      // Server configuration
      'HTTP_PORT': 'server.ports.http',
      'WS_PORT': 'server.ports.websocket',
      'EXT_PORT': 'server.ports.extension',
      'SERVER_HOST': 'server.host',
      'SERVER_TIMEOUT': 'server.timeout',
      
      // Database configuration
      'EVENT_STORE_PATH': 'database.events.path',
      'SNAPSHOT_PATH': 'database.snapshots.path',
      'SNAPSHOT_FREQUENCY': 'database.events.snapshotFrequency',
      
      // Browser configuration
      'BROWSER_TIMEOUT': 'browser.automation.timeout',
      'BROWSER_RETRIES': 'browser.automation.retries',
      'BROWSER_HEADLESS': 'browser.automation.headless',
      'PLAYWRIGHT_BROWSER': 'browser.playwright.browser',
      
      // Retry configuration
      'MAX_RETRIES': 'retry.maxRetries',
      'BASE_DELAY': 'retry.baseDelay',
      'MAX_DELAY': 'retry.maxDelay',
      
      // Monitoring configuration
      'MONITORING_ENABLED': 'monitoring.enabled',
      'METRICS_INTERVAL': 'monitoring.metricsInterval',
      
      // Logging configuration
      'LOG_LEVEL': 'logging.level',
      'LOG_FORMAT': 'logging.format',
      'LOG_DESTINATION': 'logging.destination'
    };
    
    for (const [envVar, configPath] of Object.entries(envMappings)) {
      const envValue = process.env[envVar];
      if (envValue !== undefined) {
        this.setConfigValue(configPath, this.parseEnvValue(envValue));
        this.logger.debug(`Applied environment variable ${envVar} to ${configPath}`);
      }
    }
  }

  /**
   * Parse environment variable value to appropriate type
   */
  parseEnvValue(value) {
    // Boolean values
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
    
    // Number values
    if (/^\d+$/.test(value)) return parseInt(value, 10);
    if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
    
    // JSON values (arrays, objects)
    if ((value.startsWith('[') && value.endsWith(']')) ||
        (value.startsWith('{') && value.endsWith('}'))) {
      try {
        return JSON.parse(value);
      } catch (error) {
        // If JSON parsing fails, return as string
      }
    }
    
    // String values
    return value;
  }

  /**
   * Set a configuration value using dot notation path
   */
  setConfigValue(path, value) {
    const keys = path.split('.');
    let current = this.config;
    
    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in current) || typeof current[key] !== 'object') {
        current[key] = {};
      }
      current = current[key];
    }
    
    current[keys[keys.length - 1]] = value;
  }

  /**
   * Get a configuration value using dot notation path
   */
  getConfigValue(path) {
    const keys = path.split('.');
    let current = this.config;
    
    for (const key of keys) {
      if (current && typeof current === 'object' && key in current) {
        current = current[key];
      } else {
        return undefined;
      }
    }
    
    return current;
  }

  /**
   * Get the entire configuration
   */
  getConfig() {
    return this.deepClone(this.config);
  }

  /**
   * Get configuration for a specific section
   */
  getSection(section) {
    return this.deepClone(this.config[section] || {});
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(path, value) {
    const oldValue = this.getConfigValue(path);
    this.setConfigValue(path, value);
    
    // Validate the updated configuration
    try {
      this.validateConfiguration();
      
      this.logger.info(`Configuration updated: ${path} = ${JSON.stringify(value)}`);
      this.emit('configUpdated', { path, oldValue, newValue: value });
      
    } catch (error) {
      // Revert the change if validation fails
      this.setConfigValue(path, oldValue);
      throw error;
    }
  }

  /**
   * Validate configuration against schema
   */
  validateConfiguration() {
    this.validateObject(this.config, this.configSchema, '');
  }

  /**
   * Validate object against schema recursively
   */
  validateObject(obj, schema, path) {
    for (const [key, schemaRule] of Object.entries(schema)) {
      const fullPath = path ? `${path}.${key}` : key;
      const value = obj[key];
      
      if (typeof schemaRule === 'object' && schemaRule.type) {
        // Leaf validation
        this.validateValue(value, schemaRule, fullPath);
      } else if (typeof schemaRule === 'object') {
        // Nested object validation
        if (value && typeof value === 'object') {
          this.validateObject(value, schemaRule, fullPath);
        }
      }
    }
  }

  /**
   * Validate a single value against schema rule
   */
  validateValue(value, rule, path) {
    // Check required
    if (rule.required && (value === undefined || value === null)) {
      throw new Error(`Configuration validation error: ${path} is required`);
    }
    
    if (value === undefined || value === null) {
      return; // Skip validation for optional undefined values
    }
    
    // Check type
    if (rule.type) {
      const actualType = typeof value;
      if (actualType !== rule.type) {
        throw new Error(`Configuration validation error: ${path} should be ${rule.type}, got ${actualType}`);
      }
    }
    
    // Check numeric constraints
    if (rule.type === 'number') {
      if (rule.min !== undefined && value < rule.min) {
        throw new Error(`Configuration validation error: ${path} should be at least ${rule.min}`);
      }
      if (rule.max !== undefined && value > rule.max) {
        throw new Error(`Configuration validation error: ${path} should be at most ${rule.max}`);
      }
    }
    
    // Check string constraints
    if (rule.type === 'string') {
      if (rule.minLength && value.length < rule.minLength) {
        throw new Error(`Configuration validation error: ${path} should be at least ${rule.minLength} characters`);
      }
      if (rule.maxLength && value.length > rule.maxLength) {
        throw new Error(`Configuration validation error: ${path} should be at most ${rule.maxLength} characters`);
      }
      if (rule.pattern && !new RegExp(rule.pattern).test(value)) {
        throw new Error(`Configuration validation error: ${path} does not match required pattern`);
      }
    }
    
    // Check enum values
    if (rule.enum && !rule.enum.includes(value)) {
      throw new Error(`Configuration validation error: ${path} should be one of [${rule.enum.join(', ')}]`);
    }
  }

  /**
   * Setup file watchers for configuration changes
   */
  async setupFileWatchers() {
    try {
      const configFiles = [
        'config.json',
        `config.${this.environment}.json`,
        'local.json'
      ];
      
      for (const configFile of configFiles) {
        const configPath = path.join(this.configDir, configFile);
        
        try {
          await fs.access(configPath);
          
          const watcher = fs.watch(configPath, (eventType) => {
            if (eventType === 'change') {
              this.handleConfigFileChange(configFile);
            }
          });
          
          this.watchers.set(configFile, watcher);
          this.logger.debug(`Watching config file: ${configFile}`);
          
        } catch (error) {
          // File doesn't exist, skip watching
        }
      }
      
    } catch (error) {
      this.logger.warn('Error setting up file watchers:', error.message);
    }
  }

  /**
   * Handle configuration file changes
   */
  async handleConfigFileChange(filename) {
    try {
      this.logger.info(`Configuration file changed: ${filename}`);
      
      // Reload configuration
      const oldConfig = this.deepClone(this.config);
      
      // Reset to defaults and reload
      this.config = this.deepClone(this.defaultConfig);
      await this.loadEnvironmentConfig();
      this.applyEnvironmentVariables();
      this.validateConfiguration();
      
      this.emit('configReloaded', {
        filename,
        oldConfig,
        newConfig: this.deepClone(this.config)
      });
      
    } catch (error) {
      this.logger.error(`Error reloading configuration from ${filename}:`, error);
      this.emit('configReloadError', { filename, error });
    }
  }

  /**
   * Export configuration to file
   */
  async exportConfig(filename) {
    try {
      const configPath = path.join(this.configDir, filename);
      const configContent = JSON.stringify(this.config, null, 2);
      
      await fs.writeFile(configPath, configContent, 'utf-8');
      
      this.logger.info(`Configuration exported to: ${filename}`);
      
    } catch (error) {
      this.logger.error(`Error exporting configuration to ${filename}:`, error);
      throw error;
    }
  }

  /**
   * Get configuration schema
   */
  getSchema() {
    return this.deepClone(this.configSchema);
  }

  /**
   * Get configuration summary for debugging
   */
  getConfigSummary() {
    const summary = {
      environment: this.environment,
      configDir: this.configDir,
      watchForChanges: this.watchForChanges,
      watchedFiles: Array.from(this.watchers.keys()),
      sections: Object.keys(this.config),
      validation: {
        isValid: true,
        errors: []
      }
    };
    
    // Check validation
    try {
      this.validateConfiguration();
    } catch (error) {
      summary.validation.isValid = false;
      summary.validation.errors.push(error.message);
    }
    
    return summary;
  }

  /**
   * Deep clone object
   */
  deepClone(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    
    if (obj instanceof Date) {
      return new Date(obj.getTime());
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.deepClone(item));
    }
    
    const cloned = {};
    for (const [key, value] of Object.entries(obj)) {
      cloned[key] = this.deepClone(value);
    }
    
    return cloned;
  }

  /**
   * Deep merge objects
   */
  deepMerge(target, source) {
    const result = this.deepClone(target);
    
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object' && !Array.isArray(value) &&
          result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
        result[key] = this.deepMerge(result[key], value);
      } else {
        result[key] = this.deepClone(value);
      }
    }
    
    return result;
  }

  /**
   * Shutdown configuration manager
   */
  shutdown() {
    this.logger.info('Shutting down configuration manager...');
    
    // Close file watchers
    for (const [filename, watcher] of this.watchers.entries()) {
      try {
        watcher.close();
        this.logger.debug(`Closed watcher for: ${filename}`);
      } catch (error) {
        this.logger.warn(`Error closing watcher for ${filename}:`, error.message);
      }
    }
    
    this.watchers.clear();
    this.removeAllListeners();
    
    this.logger.info('Configuration manager shut down complete');
  }
}

module.exports = ConfigurationManager;