/**
 * Correlation Tracker - Tracks requests across the entire workflow
 * Provides comprehensive tracing and monitoring capabilities
 */

const { v4: uuidv4 } = require('uuid');

class CorrelationTracker {
  constructor(options = {}) {
    this.traces = new Map();
    this.logger = options.logger || console;
    this.maxTraceAge = options.maxTraceAge || 24 * 60 * 60 * 1000; // 24 hours
    this.cleanupInterval = options.cleanupInterval || 60 * 60 * 1000; // 1 hour
    
    // Metrics
    this.metrics = {
      totalTraces: 0,
      activeTraces: 0,
      completedTraces: 0,
      failedTraces: 0,
      averageProcessingTime: 0
    };
    
    // Start cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredTraces();
    }, this.cleanupInterval);
  }

  /**
   * Create a new correlation ID and trace
   */
  createCorrelation(context = {}) {
    const correlationId = uuidv4();
    const timestamp = new Date();
    
    const trace = {
      correlationId,
      createdAt: timestamp,
      updatedAt: timestamp,
      context,
      status: 'active',
      
      // Tracked entities
      events: [],
      requests: [],
      sagas: [],
      components: new Set(),
      errors: [],
      
      // Timing information
      startTime: timestamp,
      endTime: null,
      processingTime: null,
      
      // Flow tracking
      flowSteps: [],
      currentStep: null,
      
      // Statistics
      eventCount: 0,
      requestCount: 0,
      sagaCount: 0,
      errorCount: 0,
      
      // Custom metadata
      metadata: {}
    };
    
    this.traces.set(correlationId, trace);
    this.metrics.totalTraces++;
    this.metrics.activeTraces++;
    
    this.logger.debug(`Created correlation: ${correlationId}`);
    
    return correlationId;
  }

  /**
   * Track an event in the correlation
   */
  trackEvent(correlationId, event) {
    const trace = this.traces.get(correlationId);
    if (!trace) {
      this.logger.warn(`Correlation not found: ${correlationId}`);
      return;
    }
    
    const eventInfo = {
      eventId: event.eventId,
      eventType: event.eventType,
      aggregateId: event.aggregateId,
      timestamp: new Date(),
      payload: event.payload,
      metadata: event.metadata || {}
    };
    
    trace.events.push(eventInfo);
    trace.eventCount++;
    trace.updatedAt = new Date();
    
    // Track component if available
    if (event.metadata && event.metadata.component) {
      trace.components.add(event.metadata.component);
    }
    
    // Update flow step if this is a workflow event
    this.updateFlowStep(trace, event);
    
    this.logger.debug(`Tracked event ${event.eventType} for correlation ${correlationId}`);
  }

  /**
   * Track a request in the correlation
   */
  trackRequest(correlationId, requestInfo) {
    const trace = this.traces.get(correlationId);
    if (!trace) {
      this.logger.warn(`Correlation not found: ${correlationId}`);
      return;
    }
    
    const request = {
      requestId: typeof requestInfo === 'string' ? requestInfo : requestInfo.requestId,
      timestamp: new Date(),
      component: requestInfo.component || 'unknown',
      endpoint: requestInfo.endpoint,
      method: requestInfo.method,
      payload: requestInfo.payload,
      metadata: requestInfo.metadata || {}
    };
    
    trace.requests.push(request);
    trace.requestCount++;
    trace.updatedAt = new Date();
    trace.components.add(request.component);
    
    this.logger.debug(`Tracked request ${request.requestId} for correlation ${correlationId}`);
  }

  /**
   * Track a saga in the correlation
   */
  trackSaga(correlationId, sagaInfo) {
    const trace = this.traces.get(correlationId);
    if (!trace) {
      this.logger.warn(`Correlation not found: ${correlationId}`);
      return;
    }
    
    const saga = {
      sagaId: typeof sagaInfo === 'string' ? sagaInfo : sagaInfo.sagaId,
      sagaType: sagaInfo.sagaType || 'unknown',
      timestamp: new Date(),
      status: sagaInfo.status || 'started',
      currentStep: sagaInfo.currentStep,
      metadata: sagaInfo.metadata || {}
    };
    
    trace.sagas.push(saga);
    trace.sagaCount++;
    trace.updatedAt = new Date();
    
    this.logger.debug(`Tracked saga ${saga.sagaId} for correlation ${correlationId}`);
  }

  /**
   * Track an error in the correlation
   */
  trackError(correlationId, error) {
    const trace = this.traces.get(correlationId);
    if (!trace) {
      this.logger.warn(`Correlation not found: ${correlationId}`);
      return;
    }
    
    const errorInfo = {
      timestamp: new Date(),
      component: error.component || 'unknown',
      code: error.code,
      message: error.message,
      stack: error.stack,
      retryable: error.retryable || false,
      metadata: error.metadata || {}
    };
    
    trace.errors.push(errorInfo);
    trace.errorCount++;
    trace.updatedAt = new Date();
    
    // Mark trace as failed if error is critical
    if (!error.retryable) {
      this.markCorrelationComplete(correlationId, 'failed');
    }
    
    this.logger.debug(`Tracked error ${error.code} for correlation ${correlationId}`);
  }

  /**
   * Update flow step tracking
   */
  updateFlowStep(trace, event) {
    const stepMapping = {
      'ImageGenerationRequested': 'initialization',
      'ExtensionAutomationStart': 'browser_setup',
      'ExtensionPromptInject': 'prompt_injection',
      'ExtensionImageCapture': 'image_capture',
      'ImageGenerated': 'completion',
      'WorkflowCompleted': 'finalization',
      'ErrorOccurred': 'error_handling'
    };
    
    const step = stepMapping[event.eventType];
    if (step && step !== trace.currentStep) {
      trace.flowSteps.push({
        step,
        timestamp: new Date(),
        eventType: event.eventType,
        eventId: event.eventId
      });
      trace.currentStep = step;
    }
  }

  /**
   * Mark correlation as complete
   */
  markCorrelationComplete(correlationId, status = 'completed') {
    const trace = this.traces.get(correlationId);
    if (!trace) {
      this.logger.warn(`Correlation not found: ${correlationId}`);
      return;
    }
    
    trace.status = status;
    trace.endTime = new Date();
    trace.processingTime = trace.endTime - trace.startTime;
    trace.updatedAt = trace.endTime;
    
    // Update metrics
    this.metrics.activeTraces--;
    if (status === 'completed') {
      this.metrics.completedTraces++;
    } else if (status === 'failed') {
      this.metrics.failedTraces++;
    }
    
    // Update average processing time
    this.updateAverageProcessingTime(trace.processingTime);
    
    this.logger.info(`Correlation ${correlationId} marked as ${status} (${trace.processingTime}ms)`);
  }

  /**
   * Get correlation trace
   */
  getTrace(correlationId) {
    const trace = this.traces.get(correlationId);
    if (!trace) {
      return null;
    }
    
    return {
      ...trace,
      components: Array.from(trace.components)
    };
  }

  /**
   * Generate comprehensive report for a correlation
   */
  generateReport(correlationId) {
    const trace = this.getTrace(correlationId);
    if (!trace) {
      return null;
    }
    
    return {
      correlationId,
      summary: {
        status: trace.status,
        processingTime: trace.processingTime,
        eventCount: trace.eventCount,
        requestCount: trace.requestCount,
        sagaCount: trace.sagaCount,
        errorCount: trace.errorCount,
        componentCount: trace.components.length
      },
      
      timing: {
        startTime: trace.startTime,
        endTime: trace.endTime,
        totalDuration: trace.processingTime,
        flowSteps: trace.flowSteps.map(step => ({
          ...step,
          duration: this.calculateStepDuration(trace.flowSteps, step)
        }))
      },
      
      components: trace.components,
      
      events: trace.events.map(event => ({
        ...event,
        relativeTime: event.timestamp - trace.startTime
      })),
      
      requests: trace.requests.map(request => ({
        ...request,
        relativeTime: request.timestamp - trace.startTime
      })),
      
      sagas: trace.sagas,
      
      errors: trace.errors.map(error => ({
        ...error,
        relativeTime: error.timestamp - trace.startTime
      })),
      
      context: trace.context,
      metadata: trace.metadata
    };
  }

  /**
   * Calculate duration for a flow step
   */
  calculateStepDuration(flowSteps, currentStep) {
    const currentIndex = flowSteps.indexOf(currentStep);
    if (currentIndex === -1 || currentIndex === flowSteps.length - 1) {
      return null;
    }
    
    const nextStep = flowSteps[currentIndex + 1];
    return nextStep.timestamp - currentStep.timestamp;
  }

  /**
   * Get all active correlations
   */
  getActiveCorrelations() {
    const active = [];
    
    for (const [correlationId, trace] of this.traces.entries()) {
      if (trace.status === 'active') {
        active.push({
          correlationId,
          createdAt: trace.createdAt,
          updatedAt: trace.updatedAt,
          eventCount: trace.eventCount,
          currentStep: trace.currentStep,
          components: Array.from(trace.components)
        });
      }
    }
    
    return active;
  }

  /**
   * Search traces by criteria
   */
  searchTraces(criteria) {
    const results = [];
    
    for (const [correlationId, trace] of this.traces.entries()) {
      let matches = true;
      
      if (criteria.status && trace.status !== criteria.status) {
        matches = false;
      }
      
      if (criteria.component && !trace.components.has(criteria.component)) {
        matches = false;
      }
      
      if (criteria.eventType) {
        const hasEventType = trace.events.some(event => event.eventType === criteria.eventType);
        if (!hasEventType) matches = false;
      }
      
      if (criteria.timeRange) {
        const { start, end } = criteria.timeRange;
        if (trace.createdAt < start || trace.createdAt > end) {
          matches = false;
        }
      }
      
      if (criteria.minProcessingTime && trace.processingTime < criteria.minProcessingTime) {
        matches = false;
      }
      
      if (criteria.hasErrors && trace.errorCount === 0) {
        matches = false;
      }
      
      if (matches) {
        results.push({
          correlationId,
          summary: {
            status: trace.status,
            processingTime: trace.processingTime,
            eventCount: trace.eventCount,
            errorCount: trace.errorCount,
            components: Array.from(trace.components)
          }
        });
      }
    }
    
    return results;
  }

  /**
   * Get system-wide metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      traceStorageSize: this.traces.size,
      oldestTrace: this.getOldestTraceAge(),
      componentsInUse: this.getUniqueComponents().size
    };
  }

  /**
   * Get unique components across all traces
   */
  getUniqueComponents() {
    const allComponents = new Set();
    
    for (const trace of this.traces.values()) {
      for (const component of trace.components) {
        allComponents.add(component);
      }
    }
    
    return allComponents;
  }

  /**
   * Get age of oldest trace
   */
  getOldestTraceAge() {
    let oldest = null;
    
    for (const trace of this.traces.values()) {
      if (!oldest || trace.createdAt < oldest) {
        oldest = trace.createdAt;
      }
    }
    
    return oldest ? Date.now() - oldest : 0;
  }

  /**
   * Update average processing time
   */
  updateAverageProcessingTime(newTime) {
    const completedCount = this.metrics.completedTraces + this.metrics.failedTraces;
    if (completedCount === 1) {
      this.metrics.averageProcessingTime = newTime;
    } else {
      // Moving average
      this.metrics.averageProcessingTime = 
        (this.metrics.averageProcessingTime * (completedCount - 1) + newTime) / completedCount;
    }
  }

  /**
   * Clean up expired traces
   */
  cleanupExpiredTraces() {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [correlationId, trace] of this.traces.entries()) {
      const age = now - trace.createdAt.getTime();
      
      // Only clean up completed/failed traces older than maxTraceAge
      if (trace.status !== 'active' && age > this.maxTraceAge) {
        this.traces.delete(correlationId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      this.logger.info(`Cleaned up ${cleanedCount} expired traces`);
    }
  }

  /**
   * Export trace data for analysis
   */
  exportTraces(format = 'json') {
    const data = {
      exportedAt: new Date().toISOString(),
      metrics: this.getMetrics(),
      traces: []
    };
    
    for (const [correlationId, trace] of this.traces.entries()) {
      data.traces.push({
        correlationId,
        ...trace,
        components: Array.from(trace.components)
      });
    }
    
    if (format === 'json') {
      return JSON.stringify(data, null, 2);
    }
    
    return data;
  }

  /**
   * Shutdown the tracker
   */
  shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    this.logger.info(`Correlation tracker shutdown. Final stats: ${JSON.stringify(this.getMetrics())}`);
    
    // Clear all traces
    this.traces.clear();
  }
}

module.exports = CorrelationTracker;