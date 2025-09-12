/**
 * Communication Server - Main orchestration server integrating all components
 * Provides unified event-driven communication layer for ChatGPT image generation
 */

const EventEmitter = require('events');

// Core communication components
const EventRouter = require('./communication/event-router');
const CorrelationTracker = require('./communication/correlation-tracker');
const { EventValidator } = require('./communication/event-schemas');

// Adapters
const CliServerAdapter = require('./adapters/cli-server-adapter');
const ServerExtensionAdapter = require('./adapters/server-extension-adapter');
const ServerPlaywrightAdapter = require('./adapters/server-playwright-adapter');

// Infrastructure
const RetryManager = require('./error-handling/retry-manager');
const SystemMonitor = require('./monitoring/system-monitor');
const ConfigurationManager = require('./config/configuration-manager');

// Event sourcing foundation (using existing Semantest infrastructure)
const EventSourcedWebSocketServer = require('../nodejs.server/src/websocket-event-sourced-enhanced');

class CommunicationServer extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.options = {
      configDir: options.configDir || './config',
      environment: options.environment || process.env.NODE_ENV || 'development',
      logger: options.logger || console,
      enableMonitoring: options.enableMonitoring !== false,
      enableFileWatching: options.enableFileWatching !== false,
      ...options
    };
    
    this.logger = this.options.logger;
    
    // Core components
    this.configManager = null;
    this.eventRouter = null;
    this.correlationTracker = null;
    this.retryManager = null;
    this.systemMonitor = null;
    this.eventValidator = new EventValidator();
    
    // Adapters
    this.cliAdapter = null;
    this.extensionAdapter = null;
    this.playwrightAdapter = null;
    
    // Event sourcing server (Semantest foundation)
    this.eventSourcedServer = null;
    
    // Server state
    this.isStarted = false;
    this.isShuttingDown = false;
    this.startTime = null;
    
    // Graceful shutdown handlers
    this.setupGracefulShutdown();
  }

  /**
   * Initialize and start the communication server
   */
  async start() {
    if (this.isStarted) {
      throw new Error('Communication server is already started');
    }
    
    this.startTime = Date.now();
    
    try {
      this.logger.info('🚀 Starting Communication Server...');
      
      // Initialize configuration manager
      await this.initializeConfigManager();
      
      // Initialize core components
      await this.initializeCoreComponents();
      
      // Initialize adapters
      await this.initializeAdapters();
      
      // Start event sourcing server (Semantest foundation)
      await this.startEventSourcingServer();
      
      // Connect components to event router
      this.connectComponents();
      
      // Start monitoring
      if (this.options.enableMonitoring) {
        this.startMonitoring();
      }
      
      this.isStarted = true;
      
      const startupTime = Date.now() - this.startTime;
      
      this.logger.info(`✅ Communication Server started successfully in ${startupTime}ms`);
      this.logger.info(`📊 Server Configuration:`);
      this.logger.info(`   Environment: ${this.configManager.environment}`);
      this.logger.info(`   HTTP Port: ${this.configManager.getConfigValue('server.ports.http')}`);
      this.logger.info(`   WebSocket Port: ${this.configManager.getConfigValue('server.ports.websocket')}`);
      this.logger.info(`   Extension Port: ${this.configManager.getConfigValue('server.ports.extension')}`);
      this.logger.info(`   Monitoring: ${this.options.enableMonitoring ? 'Enabled' : 'Disabled'}`);
      
      this.emit('started', {
        startupTime,
        configuration: this.configManager.getConfigSummary()
      });
      
    } catch (error) {
      this.logger.error('❌ Failed to start communication server:', error);
      
      // Cleanup on failure
      await this.cleanup();
      
      throw error;
    }
  }

  /**
   * Initialize configuration manager
   */
  async initializeConfigManager() {
    this.logger.info('📋 Initializing configuration manager...');
    
    this.configManager = new ConfigurationManager({
      configDir: this.options.configDir,
      environment: this.options.environment,
      watchForChanges: this.options.enableFileWatching,
      logger: this.logger
    });
    
    await this.configManager.initialize();
    
    // Listen for configuration changes
    this.configManager.on('configReloaded', (event) => {
      this.logger.info('⚙️ Configuration reloaded, restarting affected components...');
      this.handleConfigurationChange(event);
    });
    
    this.logger.info('✅ Configuration manager initialized');
  }

  /**
   * Initialize core communication components
   */
  async initializeCoreComponents() {
    this.logger.info('🔧 Initializing core components...');
    
    // Initialize correlation tracker
    this.correlationTracker = new CorrelationTracker({
      logger: this.logger,
      maxTraceAge: 24 * 60 * 60 * 1000, // 24 hours
      cleanupInterval: 60 * 60 * 1000   // 1 hour
    });
    
    // Initialize retry manager
    this.retryManager = new RetryManager({
      logger: this.logger,
      defaultConfig: this.configManager.getSection('retry'),
      circuitBreakerDefaults: this.configManager.getSection('circuitBreaker')
    });
    
    // Initialize event router
    this.eventRouter = new EventRouter({
      correlationTracker: this.correlationTracker,
      logger: this.logger,
      retryConfig: this.configManager.getSection('retry')
    });
    
    // Initialize system monitor
    if (this.options.enableMonitoring) {
      const monitoringConfig = this.configManager.getSection('monitoring');
      
      this.systemMonitor = new SystemMonitor({
        logger: this.logger,
        metricsInterval: monitoringConfig.metricsInterval,
        alertThresholds: monitoringConfig.alertThresholds
      });
    }
    
    this.logger.info('✅ Core components initialized');
  }

  /**
   * Initialize communication adapters
   */
  async initializeAdapters() {
    this.logger.info('🔌 Initializing communication adapters...');
    
    const serverConfig = this.configManager.getSection('server');
    
    // Initialize CLI-Server adapter
    this.cliAdapter = new CliServerAdapter({
      port: serverConfig.ports.http,
      wsPort: serverConfig.ports.websocket,
      logger: this.logger,
      eventRouter: this.eventRouter,
      correlationTracker: this.correlationTracker
    });
    
    // Initialize Server-Extension adapter
    this.extensionAdapter = new ServerExtensionAdapter({
      port: serverConfig.ports.extension,
      logger: this.logger,
      eventRouter: this.eventRouter,
      correlationTracker: this.correlationTracker
    });
    
    // Initialize Server-Playwright adapter
    this.playwrightAdapter = new ServerPlaywrightAdapter({
      logger: this.logger,
      eventRouter: this.eventRouter,
      correlationTracker: this.correlationTracker
    });
    
    // Start adapters
    await this.cliAdapter.start();
    await this.extensionAdapter.start();
    await this.playwrightAdapter.initialize(); // Playwright doesn't need port binding
    
    this.logger.info('✅ Communication adapters initialized');
  }

  /**
   * Start event sourcing server (Semantest foundation)
   */
  async startEventSourcingServer() {
    this.logger.info('📡 Starting event sourcing server...');
    
    const databaseConfig = this.configManager.getSection('database');
    
    this.eventSourcedServer = new EventSourcedWebSocketServer(
      this.configManager.getConfigValue('server.ports.websocket') + 1, // Use separate port
      {
        path: '/events',
        storePath: databaseConfig.events.path,
        snapshotPath: databaseConfig.snapshots.path,
        snapshotFrequency: databaseConfig.events.snapshotFrequency
      }
    );
    
    await this.eventSourcedServer.start();
    
    this.logger.info('✅ Event sourcing server started');
  }

  /**
   * Connect components to event router
   */
  connectComponents() {
    this.logger.info('🔗 Connecting components to event router...');
    
    // Register adapters with event router
    this.eventRouter.registerComponent('cli', this.cliAdapter, {
      type: 'cli-adapter',
      capabilities: ['http-api', 'websocket', 'request-handling']
    });
    
    this.eventRouter.registerComponent('extension', this.extensionAdapter, {
      type: 'extension-adapter',
      capabilities: ['websocket', 'browser-automation', 'chrome-extension']
    });
    
    this.eventRouter.registerComponent('playwright', this.playwrightAdapter, {
      type: 'playwright-adapter',
      capabilities: ['headless-browser', 'automation', 'screenshot']
    });
    
    // Connect event sourcing to correlation tracking
    if (this.eventSourcedServer.eventStore) {
      this.eventSourcedServer.eventStore.on('eventAppended', (envelope) => {
        const event = envelope.event;
        if (event.metadata && event.metadata.correlationId) {
          this.correlationTracker.trackEvent(event.metadata.correlationId, event);
        }
      });
    }
    
    this.logger.info('✅ Components connected to event router');
  }

  /**
   * Start monitoring systems
   */
  startMonitoring() {
    if (!this.systemMonitor) return;
    
    this.logger.info('📊 Starting monitoring systems...');
    
    // Register components with monitor
    this.systemMonitor.registerComponent('cli-adapter', this.cliAdapter, {
      type: 'adapter',
      healthCheck: () => this.cliAdapter.server && this.cliAdapter.server.listening
    });
    
    this.systemMonitor.registerComponent('extension-adapter', this.extensionAdapter, {
      type: 'adapter',
      healthCheck: () => this.extensionAdapter.wsServer && this.extensionAdapter.wsServer.readyState === 1
    });
    
    this.systemMonitor.registerComponent('playwright-adapter', this.playwrightAdapter, {
      type: 'adapter',
      healthCheck: () => this.playwrightAdapter.healthCheck()
    });
    
    this.systemMonitor.registerComponent('event-sourced-server', this.eventSourcedServer, {
      type: 'infrastructure',
      healthCheck: () => this.eventSourcedServer.wsServer && this.eventSourcedServer.wsServer.readyState === 1
    });
    
    // Set up monitoring event handlers
    this.systemMonitor.on('alert', (alert) => {
      this.logger.warn(`🚨 SYSTEM ALERT: ${alert.type}`, alert.data);
      this.emit('alert', alert);
    });
    
    this.systemMonitor.on('metricsCollected', (metrics) => {
      this.emit('metricsCollected', metrics);
    });
    
    this.logger.info('✅ Monitoring systems started');
  }

  /**
   * Handle configuration changes
   */
  async handleConfigurationChange(event) {
    try {
      // This is a simplified implementation
      // In production, you'd want more granular restart logic
      this.logger.warn('Configuration change detected - full restart may be required');
      
      this.emit('configurationChanged', event);
      
    } catch (error) {
      this.logger.error('Error handling configuration change:', error);
    }
  }

  /**
   * Get server status and metrics
   */
  getStatus() {
    const status = {
      isStarted: this.isStarted,
      isShuttingDown: this.isShuttingDown,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      environment: this.configManager?.environment,
      
      components: {
        configManager: !!this.configManager,
        eventRouter: !!this.eventRouter,
        correlationTracker: !!this.correlationTracker,
        retryManager: !!this.retryManager,
        systemMonitor: !!this.systemMonitor,
        cliAdapter: this.cliAdapter?.server?.listening || false,
        extensionAdapter: this.extensionAdapter?.wsServer?.readyState === 1 || false,
        playwrightAdapter: !!this.playwrightAdapter,
        eventSourcedServer: this.eventSourcedServer?.wsServer?.readyState === 1 || false
      }
    };
    
    // Add metrics if monitoring is enabled
    if (this.systemMonitor) {
      status.metrics = this.systemMonitor.getMetrics();
    }
    
    // Add event router stats
    if (this.eventRouter) {
      status.eventRouter = this.eventRouter.getComponentStats();
    }
    
    // Add correlation tracker stats
    if (this.correlationTracker) {
      status.correlationTracker = this.correlationTracker.getMetrics();
    }
    
    return status;
  }

  /**
   * Get performance report
   */
  getPerformanceReport() {
    if (!this.systemMonitor) {
      return { error: 'Monitoring not enabled' };
    }
    
    return this.systemMonitor.getPerformanceReport();
  }

  /**
   * Get configuration
   */
  getConfiguration() {
    if (!this.configManager) {
      return { error: 'Configuration manager not initialized' };
    }
    
    return this.configManager.getConfigSummary();
  }

  /**
   * Process an image generation request (main workflow entry point)
   */
  async processImageGenerationRequest(requestData) {
    if (!this.isStarted) {
      throw new Error('Communication server not started');
    }
    
    try {
      // Create correlation ID for tracking
      const correlationId = this.correlationTracker.createCorrelation({
        type: 'image_generation',
        source: 'api',
        prompt: requestData.prompt
      });
      
      // Create and validate the request event
      const requestEvent = this.eventValidator.createEvent('ImageGenerationRequested', {
        ...requestData,
        correlationId
      });
      
      // Route through the system
      await this.eventRouter.routeEvent(requestEvent, 'api');
      
      return {
        correlationId,
        requestId: requestEvent.requestId,
        status: 'accepted',
        message: 'Request accepted for processing'
      };
      
    } catch (error) {
      this.logger.error('Error processing image generation request:', error);
      throw error;
    }
  }

  /**
   * Get request status by correlation ID
   */
  getRequestStatus(correlationId) {
    if (!this.correlationTracker) {
      throw new Error('Correlation tracker not available');
    }
    
    const report = this.correlationTracker.generateReport(correlationId);
    if (!report) {
      throw new Error(`Request with correlation ID ${correlationId} not found`);
    }
    
    return report;
  }

  /**
   * Setup graceful shutdown handlers
   */
  setupGracefulShutdown() {
    const shutdownHandler = async (signal) => {
      this.logger.info(`🛑 Received ${signal}, initiating graceful shutdown...`);
      
      try {
        await this.shutdown();
        process.exit(0);
      } catch (error) {
        this.logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };
    
    process.on('SIGTERM', shutdownHandler);
    process.on('SIGINT', shutdownHandler);
    
    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      this.logger.error('💥 Uncaught Exception:', error);
      shutdownHandler('UNCAUGHT_EXCEPTION');
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
      shutdownHandler('UNHANDLED_REJECTION');
    });
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    if (this.isShuttingDown) {
      this.logger.warn('Shutdown already in progress');
      return;
    }
    
    this.isShuttingDown = true;
    const shutdownStart = Date.now();
    
    this.logger.info('🛑 Starting graceful shutdown...');
    
    try {
      // Stop accepting new requests
      this.emit('shuttingDown');
      
      // Shutdown components in reverse order of startup
      const shutdownPromises = [];
      
      if (this.systemMonitor) {
        this.logger.info('📊 Shutting down system monitor...');
        shutdownPromises.push(this.systemMonitor.shutdown());
      }
      
      if (this.eventSourcedServer) {
        this.logger.info('📡 Shutting down event sourcing server...');
        shutdownPromises.push(this.eventSourcedServer.shutdown());
      }
      
      if (this.playwrightAdapter) {
        this.logger.info('🎭 Shutting down Playwright adapter...');
        shutdownPromises.push(this.playwrightAdapter.shutdown());
      }
      
      if (this.extensionAdapter) {
        this.logger.info('🔌 Shutting down extension adapter...');
        shutdownPromises.push(this.extensionAdapter.shutdown());
      }
      
      if (this.cliAdapter) {
        this.logger.info('💻 Shutting down CLI adapter...');
        shutdownPromises.push(this.cliAdapter.shutdown());
      }
      
      if (this.retryManager) {
        this.logger.info('🔄 Shutting down retry manager...');
        shutdownPromises.push(this.retryManager.shutdown());
      }
      
      if (this.correlationTracker) {
        this.logger.info('🔍 Shutting down correlation tracker...');
        shutdownPromises.push(this.correlationTracker.shutdown());
      }
      
      if (this.eventRouter) {
        this.logger.info('🚦 Shutting down event router...');
        shutdownPromises.push(this.eventRouter.shutdown());
      }
      
      if (this.configManager) {
        this.logger.info('⚙️ Shutting down configuration manager...');
        shutdownPromises.push(this.configManager.shutdown());
      }
      
      // Wait for all components to shutdown
      await Promise.allSettled(shutdownPromises);
      
      // Final cleanup
      await this.cleanup();
      
      const shutdownTime = Date.now() - shutdownStart;
      this.logger.info(`✅ Graceful shutdown completed in ${shutdownTime}ms`);
      
      this.emit('shutdown', { shutdownTime });
      
    } catch (error) {
      this.logger.error('❌ Error during shutdown:', error);
      throw error;
    }
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    // Remove all event listeners
    this.removeAllListeners();
    
    // Clear references
    this.configManager = null;
    this.eventRouter = null;
    this.correlationTracker = null;
    this.retryManager = null;
    this.systemMonitor = null;
    this.cliAdapter = null;
    this.extensionAdapter = null;
    this.playwrightAdapter = null;
    this.eventSourcedServer = null;
    
    this.isStarted = false;
  }
}

module.exports = CommunicationServer;