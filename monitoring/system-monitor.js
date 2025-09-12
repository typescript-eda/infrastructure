/**
 * System Monitor - Comprehensive monitoring and logging for the communication layer
 * Provides real-time metrics, health checks, and diagnostic capabilities
 */

const EventEmitter = require('events');
const { performance } = require('perf_hooks');

class SystemMonitor extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.logger = options.logger || console;
    this.metricsInterval = options.metricsInterval || 30000; // 30 seconds
    this.alertThresholds = {
      errorRate: options.errorRateThreshold || 0.1, // 10%
      responseTime: options.responseTimeThreshold || 5000, // 5 seconds
      memoryUsage: options.memoryUsageThreshold || 0.8, // 80%
      cpuUsage: options.cpuUsageThreshold || 0.8, // 80%
      ...options.alertThresholds
    };
    
    // Metrics storage
    this.metrics = {
      system: {
        startTime: Date.now(),
        uptime: 0,
        memoryUsage: {},
        cpuUsage: 0
      },
      requests: {
        total: 0,
        successful: 0,
        failed: 0,
        averageResponseTime: 0,
        responseTimeHistory: []
      },
      events: {
        total: 0,
        byType: {},
        processingTime: []
      },
      components: {},
      errors: {
        total: 0,
        byType: {},
        byComponent: {},
        recent: []
      },
      performance: {
        responseTimeP95: 0,
        responseTimeP99: 0,
        throughput: 0
      }
    };
    
    // Component health tracking
    this.componentHealth = new Map();
    
    // Alert state tracking
    this.activeAlerts = new Map();
    
    // Timers
    this.metricsTimer = null;
    this.healthCheckTimer = null;
    
    // Performance tracking
    this.performanceObserver = null;
    
    // Request tracking
    this.activeRequests = new Map();
    
    this.initializeMonitoring();
  }

  /**
   * Initialize monitoring systems
   */
  initializeMonitoring() {
    // Start metrics collection
    this.startMetricsCollection();
    
    // Start periodic health checks
    this.startHealthChecks();
    
    // Setup performance monitoring
    this.setupPerformanceMonitoring();
    
    this.logger.info('System monitoring initialized');
  }

  /**
   * Start metrics collection timer
   */
  startMetricsCollection() {
    this.metricsTimer = setInterval(() => {
      this.collectSystemMetrics();
      this.calculatePerformanceMetrics();
      this.checkAlertConditions();
    }, this.metricsInterval);
  }

  /**
   * Start health check timer
   */
  startHealthChecks() {
    this.healthCheckTimer = setInterval(() => {
      this.performHealthChecks();
    }, 60000); // Every minute
  }

  /**
   * Setup performance monitoring
   */
  setupPerformanceMonitoring() {
    // Monitor garbage collection
    if (process.env.NODE_ENV !== 'production') {
      try {
        const { PerformanceObserver } = require('perf_hooks');
        
        this.performanceObserver = new PerformanceObserver((list) => {
          list.getEntries().forEach((entry) => {
            if (entry.entryType === 'gc') {
              this.recordMetric('gc', {
                kind: entry.kind,
                duration: entry.duration,
                timestamp: entry.startTime
              });
            }
          });
        });
        
        this.performanceObserver.observe({ entryTypes: ['gc'] });
      } catch (error) {
        this.logger.warn('Performance monitoring not available:', error.message);
      }
    }
  }

  /**
   * Register a component for monitoring
   */
  registerComponent(componentId, component, options = {}) {
    this.componentHealth.set(componentId, {
      id: componentId,
      component,
      type: options.type || 'unknown',
      lastHealthCheck: null,
      healthy: true,
      healthCheckFunction: options.healthCheck,
      metrics: {
        requests: 0,
        errors: 0,
        averageResponseTime: 0,
        lastActivity: Date.now()
      }
    });
    
    // Initialize component metrics
    this.metrics.components[componentId] = {
      requests: 0,
      errors: 0,
      responseTime: [],
      events: 0,
      lastActivity: Date.now()
    };
    
    this.logger.info(`Component registered for monitoring: ${componentId}`);
  }

  /**
   * Record a request start
   */
  recordRequestStart(requestId, metadata = {}) {
    const requestInfo = {
      id: requestId,
      startTime: performance.now(),
      startTimestamp: Date.now(),
      metadata,
      component: metadata.component
    };
    
    this.activeRequests.set(requestId, requestInfo);
    this.metrics.requests.total++;
    
    if (metadata.component) {
      const componentMetrics = this.metrics.components[metadata.component];
      if (componentMetrics) {
        componentMetrics.requests++;
        componentMetrics.lastActivity = Date.now();
      }
    }
  }

  /**
   * Record a request completion
   */
  recordRequestEnd(requestId, success = true, error = null) {
    const requestInfo = this.activeRequests.get(requestId);
    if (!requestInfo) {
      return;
    }
    
    const endTime = performance.now();
    const responseTime = endTime - requestInfo.startTime;
    
    // Update request metrics
    if (success) {
      this.metrics.requests.successful++;
    } else {
      this.metrics.requests.failed++;
      
      if (error) {
        this.recordError(error, requestInfo.metadata.component);
      }
    }
    
    // Update response time metrics
    this.metrics.requests.responseTimeHistory.push(responseTime);
    
    // Keep only recent response times (last 1000)
    if (this.metrics.requests.responseTimeHistory.length > 1000) {
      this.metrics.requests.responseTimeHistory = 
        this.metrics.requests.responseTimeHistory.slice(-1000);
    }
    
    // Update component metrics
    if (requestInfo.component) {
      const componentMetrics = this.metrics.components[requestInfo.component];
      if (componentMetrics) {
        componentMetrics.responseTime.push(responseTime);
        
        if (!success) {
          componentMetrics.errors++;
        }
        
        // Keep only recent response times for component
        if (componentMetrics.responseTime.length > 100) {
          componentMetrics.responseTime = componentMetrics.responseTime.slice(-100);
        }
      }
    }
    
    this.activeRequests.delete(requestId);
  }

  /**
   * Record an event
   */
  recordEvent(eventType, metadata = {}) {
    this.metrics.events.total++;
    
    if (!this.metrics.events.byType[eventType]) {
      this.metrics.events.byType[eventType] = 0;
    }
    this.metrics.events.byType[eventType]++;
    
    if (metadata.component) {
      const componentMetrics = this.metrics.components[metadata.component];
      if (componentMetrics) {
        componentMetrics.events++;
        componentMetrics.lastActivity = Date.now();
      }
    }
    
    // Record processing time if available
    if (metadata.processingTime) {
      this.metrics.events.processingTime.push(metadata.processingTime);
      
      // Keep only recent processing times
      if (this.metrics.events.processingTime.length > 1000) {
        this.metrics.events.processingTime = 
          this.metrics.events.processingTime.slice(-1000);
      }
    }
  }

  /**
   * Record an error
   */
  recordError(error, component = 'unknown') {
    this.metrics.errors.total++;
    
    const errorType = error.code || error.name || 'UNKNOWN_ERROR';
    
    if (!this.metrics.errors.byType[errorType]) {
      this.metrics.errors.byType[errorType] = 0;
    }
    this.metrics.errors.byType[errorType]++;
    
    if (!this.metrics.errors.byComponent[component]) {
      this.metrics.errors.byComponent[component] = 0;
    }
    this.metrics.errors.byComponent[component]++;
    
    // Store recent errors for analysis
    const errorInfo = {
      timestamp: Date.now(),
      type: errorType,
      message: error.message,
      component,
      stack: error.stack
    };
    
    this.metrics.errors.recent.unshift(errorInfo);
    
    // Keep only recent 100 errors
    if (this.metrics.errors.recent.length > 100) {
      this.metrics.errors.recent = this.metrics.errors.recent.slice(0, 100);
    }
    
    this.logger.error(`Error recorded - ${component}: ${error.message}`);
  }

  /**
   * Record a custom metric
   */
  recordMetric(metricName, value, metadata = {}) {
    if (!this.metrics[metricName]) {
      this.metrics[metricName] = [];
    }
    
    this.metrics[metricName].push({
      value,
      timestamp: Date.now(),
      metadata
    });
    
    // Limit metric history
    if (this.metrics[metricName].length > 1000) {
      this.metrics[metricName] = this.metrics[metricName].slice(-1000);
    }
  }

  /**
   * Collect system metrics
   */
  collectSystemMetrics() {
    // Update uptime
    this.metrics.system.uptime = Date.now() - this.metrics.system.startTime;
    
    // Memory usage
    this.metrics.system.memoryUsage = process.memoryUsage();
    
    // CPU usage (approximate)
    const cpuUsage = process.cpuUsage();
    this.metrics.system.cpuUsage = cpuUsage;
    
    // Calculate averages
    this.calculateAverages();
    
    this.emit('metricsCollected', this.getMetrics());
  }

  /**
   * Calculate average metrics
   */
  calculateAverages() {
    // Average response time
    const responseTimes = this.metrics.requests.responseTimeHistory;
    if (responseTimes.length > 0) {
      this.metrics.requests.averageResponseTime = 
        responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length;
    }
    
    // Component averages
    for (const [componentId, componentMetrics] of Object.entries(this.metrics.components)) {
      const responseTimes = componentMetrics.responseTime;
      if (responseTimes.length > 0) {
        componentMetrics.averageResponseTime = 
          responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length;
      }
    }
  }

  /**
   * Calculate performance metrics (percentiles)
   */
  calculatePerformanceMetrics() {
    const responseTimes = this.metrics.requests.responseTimeHistory;
    
    if (responseTimes.length > 0) {
      const sorted = [...responseTimes].sort((a, b) => a - b);
      
      // P95
      const p95Index = Math.ceil(sorted.length * 0.95) - 1;
      this.metrics.performance.responseTimeP95 = sorted[p95Index] || 0;
      
      // P99
      const p99Index = Math.ceil(sorted.length * 0.99) - 1;
      this.metrics.performance.responseTimeP99 = sorted[p99Index] || 0;
      
      // Throughput (requests per second)
      const timeWindow = this.metricsInterval / 1000; // Convert to seconds
      const recentRequests = responseTimes.length;
      this.metrics.performance.throughput = recentRequests / timeWindow;
    }
  }

  /**
   * Perform health checks on registered components
   */
  async performHealthChecks() {
    const healthCheckPromises = [];
    
    for (const [componentId, componentInfo] of this.componentHealth.entries()) {
      if (componentInfo.healthCheckFunction) {
        healthCheckPromises.push(
          this.performSingleHealthCheck(componentId, componentInfo)
        );
      }
    }
    
    await Promise.allSettled(healthCheckPromises);
  }

  /**
   * Perform health check on a single component
   */
  async performSingleHealthCheck(componentId, componentInfo) {
    try {
      const startTime = performance.now();
      const healthResult = await componentInfo.healthCheckFunction();
      const responseTime = performance.now() - startTime;
      
      componentInfo.lastHealthCheck = Date.now();
      componentInfo.healthy = healthResult === true || (healthResult && healthResult.healthy);
      componentInfo.lastResponseTime = responseTime;
      
      if (!componentInfo.healthy) {
        this.logger.warn(`Component ${componentId} health check failed:`, healthResult);
        this.raiseAlert('component_unhealthy', {
          componentId,
          result: healthResult
        });
      } else {
        this.clearAlert('component_unhealthy', componentId);
      }
      
    } catch (error) {
      componentInfo.healthy = false;
      componentInfo.lastHealthCheck = Date.now();
      componentInfo.lastError = error.message;
      
      this.logger.error(`Component ${componentId} health check error:`, error);
      this.raiseAlert('component_error', {
        componentId,
        error: error.message
      });
    }
  }

  /**
   * Check alert conditions
   */
  checkAlertConditions() {
    // Error rate alert
    const totalRequests = this.metrics.requests.total;
    const failedRequests = this.metrics.requests.failed;
    
    if (totalRequests > 0) {
      const errorRate = failedRequests / totalRequests;
      
      if (errorRate > this.alertThresholds.errorRate) {
        this.raiseAlert('high_error_rate', {
          errorRate,
          threshold: this.alertThresholds.errorRate
        });
      } else {
        this.clearAlert('high_error_rate');
      }
    }
    
    // Response time alert
    const avgResponseTime = this.metrics.requests.averageResponseTime;
    if (avgResponseTime > this.alertThresholds.responseTime) {
      this.raiseAlert('high_response_time', {
        responseTime: avgResponseTime,
        threshold: this.alertThresholds.responseTime
      });
    } else {
      this.clearAlert('high_response_time');
    }
    
    // Memory usage alert
    const memoryUsage = this.metrics.system.memoryUsage;
    if (memoryUsage.rss && memoryUsage.heapTotal) {
      const usageRatio = memoryUsage.rss / memoryUsage.heapTotal;
      
      if (usageRatio > this.alertThresholds.memoryUsage) {
        this.raiseAlert('high_memory_usage', {
          usageRatio,
          threshold: this.alertThresholds.memoryUsage,
          memoryUsage
        });
      } else {
        this.clearAlert('high_memory_usage');
      }
    }
  }

  /**
   * Raise an alert
   */
  raiseAlert(alertType, data = {}) {
    const alertKey = `${alertType}_${data.componentId || 'system'}`;
    const existingAlert = this.activeAlerts.get(alertKey);
    
    if (!existingAlert) {
      const alert = {
        type: alertType,
        level: 'warning',
        timestamp: Date.now(),
        data,
        acknowledged: false
      };
      
      this.activeAlerts.set(alertKey, alert);
      
      this.logger.warn(`ALERT RAISED: ${alertType}`, data);
      this.emit('alert', alert);
    }
  }

  /**
   * Clear an alert
   */
  clearAlert(alertType, componentId = 'system') {
    const alertKey = `${alertType}_${componentId}`;
    const existingAlert = this.activeAlerts.get(alertKey);
    
    if (existingAlert) {
      this.activeAlerts.delete(alertKey);
      
      this.logger.info(`ALERT CLEARED: ${alertType} for ${componentId}`);
      this.emit('alertCleared', { type: alertType, componentId });
    }
  }

  /**
   * Get current metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeRequests: this.activeRequests.size,
      activeAlerts: Array.from(this.activeAlerts.values()),
      componentHealth: this.getComponentHealthSummary(),
      timestamp: Date.now()
    };
  }

  /**
   * Get component health summary
   */
  getComponentHealthSummary() {
    const summary = {};
    
    for (const [componentId, componentInfo] of this.componentHealth.entries()) {
      summary[componentId] = {
        healthy: componentInfo.healthy,
        lastHealthCheck: componentInfo.lastHealthCheck,
        lastResponseTime: componentInfo.lastResponseTime,
        lastError: componentInfo.lastError
      };
    }
    
    return summary;
  }

  /**
   * Get performance report
   */
  getPerformanceReport() {
    return {
      overview: {
        uptime: this.metrics.system.uptime,
        totalRequests: this.metrics.requests.total,
        successRate: this.metrics.requests.total > 0 ? 
          (this.metrics.requests.successful / this.metrics.requests.total) * 100 : 100,
        averageResponseTime: this.metrics.requests.averageResponseTime,
        throughput: this.metrics.performance.throughput
      },
      performance: this.metrics.performance,
      errors: {
        total: this.metrics.errors.total,
        byType: this.metrics.errors.byType,
        byComponent: this.metrics.errors.byComponent
      },
      components: this.metrics.components,
      alerts: Array.from(this.activeAlerts.values()),
      timestamp: Date.now()
    };
  }

  /**
   * Export metrics for external monitoring systems
   */
  exportMetrics(format = 'json') {
    const metrics = this.getMetrics();
    
    switch (format) {
      case 'prometheus':
        return this.formatPrometheusMetrics(metrics);
      case 'json':
      default:
        return JSON.stringify(metrics, null, 2);
    }
  }

  /**
   * Format metrics for Prometheus
   */
  formatPrometheusMetrics(metrics) {
    const lines = [];
    
    // System metrics
    lines.push(`# HELP system_uptime_seconds System uptime in seconds`);
    lines.push(`# TYPE system_uptime_seconds counter`);
    lines.push(`system_uptime_seconds ${metrics.system.uptime / 1000}`);
    
    // Request metrics
    lines.push(`# HELP http_requests_total Total HTTP requests`);
    lines.push(`# TYPE http_requests_total counter`);
    lines.push(`http_requests_total{status="success"} ${metrics.requests.successful}`);
    lines.push(`http_requests_total{status="error"} ${metrics.requests.failed}`);
    
    // Response time metrics
    lines.push(`# HELP http_request_duration_seconds HTTP request duration`);
    lines.push(`# TYPE http_request_duration_seconds histogram`);
    lines.push(`http_request_duration_seconds{quantile="0.95"} ${metrics.performance.responseTimeP95 / 1000}`);
    lines.push(`http_request_duration_seconds{quantile="0.99"} ${metrics.performance.responseTimeP99 / 1000}`);
    
    return lines.join('\n');
  }

  /**
   * Reset metrics (useful for testing)
   */
  resetMetrics() {
    this.metrics.requests.total = 0;
    this.metrics.requests.successful = 0;
    this.metrics.requests.failed = 0;
    this.metrics.requests.responseTimeHistory = [];
    this.metrics.events.total = 0;
    this.metrics.events.byType = {};
    this.metrics.errors.total = 0;
    this.metrics.errors.byType = {};
    this.metrics.errors.byComponent = {};
    this.metrics.errors.recent = [];
    
    for (const componentId of Object.keys(this.metrics.components)) {
      this.metrics.components[componentId] = {
        requests: 0,
        errors: 0,
        responseTime: [],
        events: 0,
        lastActivity: Date.now()
      };
    }
    
    this.logger.info('Metrics reset');
  }

  /**
   * Shutdown the monitor
   */
  shutdown() {
    this.logger.info('Shutting down system monitor...');
    
    // Clear timers
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
    }
    
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }
    
    // Clean up performance observer
    if (this.performanceObserver) {
      this.performanceObserver.disconnect();
    }
    
    // Clear data structures
    this.componentHealth.clear();
    this.activeAlerts.clear();
    this.activeRequests.clear();
    
    this.removeAllListeners();
    
    this.logger.info('System monitor shut down complete');
  }
}

module.exports = SystemMonitor;