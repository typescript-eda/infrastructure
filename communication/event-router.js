/**
 * Event Router - Central hub for routing events between components
 * Handles correlation tracking, event transformation, and delivery
 */

const EventEmitter = require('events');
const { EventTypes, EventValidator } = require('./event-schemas');

class EventRouter extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.validator = new EventValidator();
    this.correlationTracker = options.correlationTracker;
    this.logger = options.logger || console;
    
    // Component connections
    this.components = new Map();
    
    // Event routing rules
    this.routingRules = new Map();
    
    // Event transformation rules
    this.transformers = new Map();
    
    // Circuit breaker for components
    this.circuitBreakers = new Map();
    
    // Retry configuration
    this.retryConfig = {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      backoffFactor: 2
    };
    
    this.setupDefaultRoutes();
    this.setupTransformers();
  }

  /**
   * Register a component with the router
   */
  registerComponent(componentId, component, options = {}) {
    this.components.set(componentId, {
      component,
      type: options.type || 'unknown',
      capabilities: options.capabilities || [],
      healthCheck: options.healthCheck,
      isConnected: true,
      lastActivity: new Date(),
      messageCount: 0,
      errorCount: 0
    });

    // Initialize circuit breaker
    this.circuitBreakers.set(componentId, {
      state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
      failureCount: 0,
      lastFailure: null,
      nextRetry: null,
      threshold: options.circuitBreakerThreshold || 5,
      timeout: options.circuitBreakerTimeout || 60000
    });

    this.logger.info(`Component registered: ${componentId} (${options.type})`);
    
    // Set up component event handlers
    if (component.on) {
      component.on('message', (message) => this.handleComponentMessage(componentId, message));
      component.on('error', (error) => this.handleComponentError(componentId, error));
      component.on('disconnect', () => this.handleComponentDisconnect(componentId));
    }
  }

  /**
   * Setup default routing rules
   */
  setupDefaultRoutes() {
    // CLI → Server routes
    this.addRoute(EventTypes.IMAGE_GENERATION_REQUESTED, 'cli', 'server');
    this.addRoute(EventTypes.CLI_STATUS_CHECK, 'cli', 'server');
    
    // Server → Extension routes
    this.addRoute(EventTypes.EXTENSION_AUTOMATION_START, 'server', 'extension');
    this.addRoute(EventTypes.EXTENSION_PROMPT_INJECT, 'server', 'extension');
    this.addRoute(EventTypes.EXTENSION_IMAGE_CAPTURE, 'server', 'extension');
    
    // Server → Playwright routes
    this.addRoute(EventTypes.PLAYWRIGHT_SESSION_START, 'server', 'playwright');
    this.addRoute(EventTypes.PLAYWRIGHT_NAVIGATE, 'server', 'playwright');
    this.addRoute(EventTypes.PLAYWRIGHT_EXECUTE, 'server', 'playwright');
    
    // Response routes (all → CLI via server)
    this.addRoute(EventTypes.IMAGE_GENERATED, '*', 'cli');
    this.addRoute(EventTypes.WORKFLOW_COMPLETED, '*', 'cli');
    this.addRoute(EventTypes.ERROR_OCCURRED, '*', 'cli');
    this.addRoute(EventTypes.STATUS_UPDATE, '*', 'cli');
  }

  /**
   * Setup event transformers
   */
  setupTransformers() {
    // CLI request → Extension automation
    this.addTransformer(
      EventTypes.IMAGE_GENERATION_REQUESTED,
      EventTypes.EXTENSION_AUTOMATION_START,
      (event) => ({
        sessionId: event.requestId,
        correlationId: event.correlationId,
        domainName: event.domainName || 'chatgpt.com',
        timeout: event.timeout || 30000
      })
    );

    // Extension automation → Prompt injection
    this.addTransformer(
      EventTypes.EXTENSION_AUTOMATION_START,
      EventTypes.EXTENSION_PROMPT_INJECT,
      (event, originalRequest) => ({
        sessionId: event.sessionId,
        correlationId: event.correlationId,
        prompt: originalRequest.prompt,
        model: originalRequest.model,
        quality: originalRequest.quality,
        size: originalRequest.size
      })
    );

    // Prompt injection → Image capture
    this.addTransformer(
      EventTypes.EXTENSION_PROMPT_INJECT,
      EventTypes.EXTENSION_IMAGE_CAPTURE,
      (event, originalRequest) => ({
        sessionId: event.sessionId,
        correlationId: event.correlationId,
        downloadPath: originalRequest.downloadFolder,
        fileName: originalRequest.fileName
      })
    );
  }

  /**
   * Add a routing rule
   */
  addRoute(eventType, fromComponent, toComponent) {
    if (!this.routingRules.has(eventType)) {
      this.routingRules.set(eventType, []);
    }
    
    this.routingRules.get(eventType).push({
      from: fromComponent,
      to: toComponent
    });
  }

  /**
   * Add an event transformer
   */
  addTransformer(fromEventType, toEventType, transformFunction) {
    this.transformers.set(`${fromEventType}->${toEventType}`, transformFunction);
  }

  /**
   * Route an event to appropriate components
   */
  async routeEvent(event, fromComponent) {
    try {
      // Validate event
      this.validator.validate(event.eventType, event);
      
      // Update correlation tracking
      if (event.correlationId && this.correlationTracker) {
        this.correlationTracker.trackEvent(event.correlationId, event);
      }

      // Find routing rules for this event type
      const routes = this.routingRules.get(event.eventType) || [];
      
      const routingPromises = [];
      
      for (const route of routes) {
        if (route.from === '*' || route.from === fromComponent) {
          const targetComponent = route.to;
          
          // Check if target component is available
          if (!this.isComponentAvailable(targetComponent)) {
            this.logger.warn(`Target component ${targetComponent} not available for event ${event.eventType}`);
            continue;
          }
          
          // Route the event
          routingPromises.push(
            this.deliverEventToComponent(event, targetComponent, fromComponent)
          );
        }
      }
      
      // Execute all routing promises
      await Promise.allSettled(routingPromises);
      
      // Emit for any listeners
      this.emit('eventRouted', {
        event,
        fromComponent,
        routeCount: routingPromises.length
      });
      
    } catch (error) {
      this.logger.error(`Error routing event ${event.eventType}:`, error);
      
      // Emit error event
      const errorEvent = this.validator.createEvent(EventTypes.ERROR_OCCURRED, {
        component: 'router',
        correlationId: event.correlationId,
        requestId: event.requestId,
        error: {
          code: 'ROUTING_ERROR',
          message: error.message,
          details: { originalEvent: event }
        }
      });
      
      this.emit('error', errorEvent);
    }
  }

  /**
   * Deliver event to a specific component with retry logic
   */
  async deliverEventToComponent(event, targetComponent, sourceComponent) {
    const circuitBreaker = this.circuitBreakers.get(targetComponent);
    
    // Check circuit breaker
    if (circuitBreaker && circuitBreaker.state === 'OPEN') {
      if (Date.now() < circuitBreaker.nextRetry) {
        throw new Error(`Circuit breaker OPEN for ${targetComponent}`);
      } else {
        circuitBreaker.state = 'HALF_OPEN';
      }
    }
    
    let lastError;
    
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        // Apply transformations if needed
        const transformedEvent = await this.applyTransformations(event, targetComponent);
        
        // Deliver to component
        await this.sendToComponent(transformedEvent, targetComponent);
        
        // Update component stats
        const componentInfo = this.components.get(targetComponent);
        if (componentInfo) {
          componentInfo.messageCount++;
          componentInfo.lastActivity = new Date();
        }
        
        // Reset circuit breaker on success
        if (circuitBreaker) {
          circuitBreaker.failureCount = 0;
          circuitBreaker.state = 'CLOSED';
        }
        
        return; // Success!
        
      } catch (error) {
        lastError = error;
        
        // Update circuit breaker on failure
        if (circuitBreaker) {
          circuitBreaker.failureCount++;
          circuitBreaker.lastFailure = new Date();
          
          if (circuitBreaker.failureCount >= circuitBreaker.threshold) {
            circuitBreaker.state = 'OPEN';
            circuitBreaker.nextRetry = Date.now() + circuitBreaker.timeout;
          }
        }
        
        // Don't retry if this is the last attempt
        if (attempt === this.retryConfig.maxRetries) {
          break;
        }
        
        // Calculate delay for next retry
        const delay = Math.min(
          this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffFactor, attempt),
          this.retryConfig.maxDelay
        );
        
        this.logger.warn(`Delivery attempt ${attempt + 1} failed for ${targetComponent}, retrying in ${delay}ms:`, error.message);
        
        await this.delay(delay);
      }
    }
    
    // All retries failed
    const componentInfo = this.components.get(targetComponent);
    if (componentInfo) {
      componentInfo.errorCount++;
    }
    
    throw new Error(`Failed to deliver event to ${targetComponent} after ${this.retryConfig.maxRetries} retries: ${lastError?.message}`);
  }

  /**
   * Apply transformations to an event for a target component
   */
  async applyTransformations(event, targetComponent) {
    // Look for applicable transformers
    for (const [key, transformer] of this.transformers.entries()) {
      const [fromType, toType] = key.split('->');
      
      if (fromType === event.eventType) {
        // Get original request from correlation if needed
        let originalRequest = null;
        if (event.correlationId && this.correlationTracker) {
          const trace = this.correlationTracker.getTrace(event.correlationId);
          originalRequest = trace?.events?.find(e => e.eventType === EventTypes.IMAGE_GENERATION_REQUESTED);
        }
        
        // Apply transformation
        const transformedData = transformer(event, originalRequest);
        return this.validator.createEvent(toType, {
          ...transformedData,
          correlationId: event.correlationId,
          requestId: event.requestId
        });
      }
    }
    
    return event; // No transformation needed
  }

  /**
   * Send event to a component
   */
  async sendToComponent(event, componentId) {
    const componentInfo = this.components.get(componentId);
    if (!componentInfo) {
      throw new Error(`Component ${componentId} not registered`);
    }
    
    const { component } = componentInfo;
    
    // Different delivery methods based on component type
    if (component.send) {
      // WebSocket or similar
      component.send(JSON.stringify(event));
    } else if (component.emit) {
      // EventEmitter
      component.emit('event', event);
    } else if (component.handleEvent) {
      // Custom handler
      await component.handleEvent(event);
    } else {
      throw new Error(`No delivery method available for component ${componentId}`);
    }
  }

  /**
   * Handle message from a component
   */
  async handleComponentMessage(componentId, message) {
    try {
      let event;
      
      if (typeof message === 'string') {
        event = JSON.parse(message);
      } else {
        event = message;
      }
      
      // Route the event
      await this.routeEvent(event, componentId);
      
    } catch (error) {
      this.logger.error(`Error handling message from ${componentId}:`, error);
    }
  }

  /**
   * Handle component error
   */
  handleComponentError(componentId, error) {
    this.logger.error(`Component ${componentId} error:`, error);
    
    const componentInfo = this.components.get(componentId);
    if (componentInfo) {
      componentInfo.errorCount++;
    }
    
    // Create and route error event
    const errorEvent = this.validator.createEvent(EventTypes.ERROR_OCCURRED, {
      component: componentId,
      error: {
        code: 'COMPONENT_ERROR',
        message: error.message,
        details: { originalError: error }
      }
    });
    
    this.routeEvent(errorEvent, componentId);
  }

  /**
   * Handle component disconnect
   */
  handleComponentDisconnect(componentId) {
    this.logger.info(`Component ${componentId} disconnected`);
    
    const componentInfo = this.components.get(componentId);
    if (componentInfo) {
      componentInfo.isConnected = false;
    }
  }

  /**
   * Check if component is available
   */
  isComponentAvailable(componentId) {
    const componentInfo = this.components.get(componentId);
    if (!componentInfo) return false;
    
    const circuitBreaker = this.circuitBreakers.get(componentId);
    if (circuitBreaker && circuitBreaker.state === 'OPEN') {
      return false;
    }
    
    return componentInfo.isConnected;
  }

  /**
   * Get component statistics
   */
  getComponentStats() {
    const stats = {};
    
    for (const [componentId, componentInfo] of this.components.entries()) {
      const circuitBreaker = this.circuitBreakers.get(componentId);
      
      stats[componentId] = {
        type: componentInfo.type,
        isConnected: componentInfo.isConnected,
        messageCount: componentInfo.messageCount,
        errorCount: componentInfo.errorCount,
        lastActivity: componentInfo.lastActivity,
        circuitBreakerState: circuitBreaker?.state || 'UNKNOWN',
        circuitBreakerFailures: circuitBreaker?.failureCount || 0
      };
    }
    
    return stats;
  }

  /**
   * Perform health checks on all components
   */
  async performHealthChecks() {
    const results = {};
    
    for (const [componentId, componentInfo] of this.components.entries()) {
      try {
        if (componentInfo.healthCheck) {
          const isHealthy = await componentInfo.healthCheck();
          results[componentId] = { healthy: isHealthy, error: null };
        } else {
          // Default health check based on connection status
          results[componentId] = { healthy: componentInfo.isConnected, error: null };
        }
      } catch (error) {
        results[componentId] = { healthy: false, error: error.message };
      }
    }
    
    return results;
  }

  /**
   * Utility method for delays
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Shutdown the router and all components
   */
  async shutdown() {
    this.logger.info('Shutting down event router...');
    
    // Notify all components of shutdown
    const shutdownEvent = this.validator.createEvent(EventTypes.CLI_SHUTDOWN_REQUESTED, {
      reason: 'Router shutdown'
    });
    
    for (const [componentId] of this.components.entries()) {
      try {
        await this.sendToComponent(shutdownEvent, componentId);
      } catch (error) {
        this.logger.warn(`Failed to send shutdown to ${componentId}:`, error.message);
      }
    }
    
    // Clear all references
    this.components.clear();
    this.circuitBreakers.clear();
    this.removeAllListeners();
  }
}

module.exports = EventRouter;