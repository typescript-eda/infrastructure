/**
 * Retry Manager - Handles retry logic with exponential backoff and circuit breaker patterns
 * Provides comprehensive error handling and failure recovery mechanisms
 */

class RetryManager {
  constructor(options = {}) {
    this.logger = options.logger || console;
    
    // Default retry configuration
    this.defaultConfig = {
      maxRetries: 3,
      baseDelay: 1000, // 1 second
      maxDelay: 30000, // 30 seconds
      backoffFactor: 2,
      jitter: true, // Add randomization to prevent thundering herd
      retryCondition: this.defaultRetryCondition.bind(this)
    };
    
    // Circuit breaker configuration
    this.circuitBreakerDefaults = {
      failureThreshold: 5,
      recoveryTimeout: 60000, // 1 minute
      monitoringPeriod: 10000, // 10 seconds
      halfOpenMaxCalls: 3
    };
    
    // Active retry operations
    this.activeRetries = new Map();
    
    // Circuit breakers for different operations/services
    this.circuitBreakers = new Map();
    
    // Metrics
    this.metrics = {
      totalAttempts: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      totalRetries: 0,
      circuitBreakerTrips: 0
    };
    
    // Cleanup interval for completed operations
    this.cleanupInterval = setInterval(() => {
      this.cleanupCompletedOperations();
    }, 60000); // Clean every minute
  }

  /**
   * Execute operation with retry logic
   */
  async executeWithRetry(operationId, operation, config = {}) {
    const retryConfig = { ...this.defaultConfig, ...config };
    const startTime = Date.now();
    
    // Check if operation already in progress
    if (this.activeRetries.has(operationId)) {
      throw new Error(`Operation ${operationId} already in progress`);
    }
    
    // Initialize operation tracking
    const operationInfo = {
      operationId,
      startTime,
      attempts: 0,
      lastError: null,
      status: 'running',
      config: retryConfig
    };
    
    this.activeRetries.set(operationId, operationInfo);
    
    try {
      const result = await this.performOperation(operationInfo, operation);
      
      // Success
      operationInfo.status = 'completed';
      operationInfo.completedAt = Date.now();
      operationInfo.result = result;
      
      this.metrics.totalSuccesses++;
      
      this.logger.debug(`Operation ${operationId} completed successfully after ${operationInfo.attempts} attempts`);
      
      return result;
      
    } catch (error) {
      operationInfo.status = 'failed';
      operationInfo.completedAt = Date.now();
      operationInfo.finalError = error;
      
      this.metrics.totalFailures++;
      
      this.logger.error(`Operation ${operationId} failed after ${operationInfo.attempts} attempts:`, error);
      
      throw error;
    }
  }

  /**
   * Perform operation with retry attempts
   */
  async performOperation(operationInfo, operation) {
    const { operationId, config } = operationInfo;
    
    for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
      operationInfo.attempts = attempt + 1;
      this.metrics.totalAttempts++;
      
      try {
        // Execute the operation
        const result = await operation(attempt);
        
        // Success - reset any circuit breaker for this operation type
        if (operationInfo.circuitBreakerKey) {
          this.resetCircuitBreaker(operationInfo.circuitBreakerKey);
        }
        
        return result;
        
      } catch (error) {
        operationInfo.lastError = error;
        
        this.logger.warn(`Operation ${operationId} attempt ${attempt + 1} failed:`, error.message);
        
        // Check if we should retry
        if (attempt === config.maxRetries) {
          // No more retries
          break;
        }
        
        if (!config.retryCondition(error, attempt)) {
          // Error is not retryable
          this.logger.info(`Operation ${operationId} error is not retryable:`, error.message);
          break;
        }
        
        // Calculate delay for next attempt
        const delay = this.calculateDelay(attempt, config);
        
        this.logger.debug(`Operation ${operationId} retrying in ${delay}ms (attempt ${attempt + 2}/${config.maxRetries + 1})`);
        
        this.metrics.totalRetries++;
        
        // Wait before retry
        await this.delay(delay);
      }
    }
    
    // All retries exhausted
    throw operationInfo.lastError;
  }

  /**
   * Calculate retry delay with exponential backoff and jitter
   */
  calculateDelay(attempt, config) {
    let delay = config.baseDelay * Math.pow(config.backoffFactor, attempt);
    
    // Apply maximum delay limit
    delay = Math.min(delay, config.maxDelay);
    
    // Add jitter to prevent thundering herd
    if (config.jitter) {
      const jitterRange = delay * 0.1; // 10% jitter
      const jitter = (Math.random() * jitterRange * 2) - jitterRange;
      delay += jitter;
    }
    
    return Math.max(delay, 0);
  }

  /**
   * Default retry condition - determines if error is retryable
   */
  defaultRetryCondition(error, attempt) {
    // Don't retry validation errors or client errors (4xx)
    if (error.code && error.code.startsWith('VALIDATION_')) {
      return false;
    }
    
    if (error.status >= 400 && error.status < 500) {
      // Client errors - don't retry except for specific cases
      return error.status === 408 || error.status === 429; // Timeout or rate limit
    }
    
    // Don't retry authentication failures
    if (error.code === 'AUTHENTICATION_FAILED') {
      return false;
    }
    
    // Retry network errors, server errors, timeouts
    return true;
  }

  /**
   * Create a circuit breaker for an operation type
   */
  createCircuitBreaker(key, config = {}) {
    const circuitConfig = { ...this.circuitBreakerDefaults, ...config };
    
    const circuitBreaker = {
      key,
      state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
      failureCount: 0,
      lastFailureTime: null,
      nextAttemptTime: null,
      halfOpenCalls: 0,
      config: circuitConfig,
      metrics: {
        totalRequests: 0,
        totalFailures: 0,
        totalSuccesses: 0
      }
    };
    
    this.circuitBreakers.set(key, circuitBreaker);
    
    this.logger.info(`Circuit breaker created for ${key}`);
    
    return circuitBreaker;
  }

  /**
   * Execute operation with circuit breaker protection
   */
  async executeWithCircuitBreaker(key, operation, config = {}) {
    let circuitBreaker = this.circuitBreakers.get(key);
    
    if (!circuitBreaker) {
      circuitBreaker = this.createCircuitBreaker(key, config.circuitBreaker);
    }
    
    // Check circuit breaker state
    if (circuitBreaker.state === 'OPEN') {
      if (Date.now() < circuitBreaker.nextAttemptTime) {
        throw new Error(`Circuit breaker OPEN for ${key}. Next attempt at ${new Date(circuitBreaker.nextAttemptTime)}`);
      } else {
        // Transition to HALF_OPEN
        circuitBreaker.state = 'HALF_OPEN';
        circuitBreaker.halfOpenCalls = 0;
        this.logger.info(`Circuit breaker for ${key} transitioning to HALF_OPEN`);
      }
    }
    
    if (circuitBreaker.state === 'HALF_OPEN') {
      if (circuitBreaker.halfOpenCalls >= circuitBreaker.config.halfOpenMaxCalls) {
        throw new Error(`Circuit breaker HALF_OPEN for ${key} - max calls exceeded`);
      }
      circuitBreaker.halfOpenCalls++;
    }
    
    circuitBreaker.metrics.totalRequests++;
    
    try {
      const result = await operation();
      
      // Success
      circuitBreaker.metrics.totalSuccesses++;
      
      if (circuitBreaker.state === 'HALF_OPEN') {
        // Successful calls in HALF_OPEN state
        if (circuitBreaker.halfOpenCalls >= circuitBreaker.config.halfOpenMaxCalls) {
          // All test calls succeeded, close the circuit
          this.closeCircuitBreaker(circuitBreaker);
        }
      }
      
      return result;
      
    } catch (error) {
      // Failure
      circuitBreaker.metrics.totalFailures++;
      circuitBreaker.failureCount++;
      circuitBreaker.lastFailureTime = Date.now();
      
      if (circuitBreaker.state === 'HALF_OPEN') {
        // Failure in HALF_OPEN state - back to OPEN
        this.openCircuitBreaker(circuitBreaker);
      } else if (circuitBreaker.failureCount >= circuitBreaker.config.failureThreshold) {
        // Failure threshold exceeded - open circuit
        this.openCircuitBreaker(circuitBreaker);
      }
      
      throw error;
    }
  }

  /**
   * Open a circuit breaker
   */
  openCircuitBreaker(circuitBreaker) {
    circuitBreaker.state = 'OPEN';
    circuitBreaker.nextAttemptTime = Date.now() + circuitBreaker.config.recoveryTimeout;
    
    this.metrics.circuitBreakerTrips++;
    
    this.logger.warn(`Circuit breaker OPENED for ${circuitBreaker.key}. Recovery at ${new Date(circuitBreaker.nextAttemptTime)}`);
  }

  /**
   * Close a circuit breaker
   */
  closeCircuitBreaker(circuitBreaker) {
    circuitBreaker.state = 'CLOSED';
    circuitBreaker.failureCount = 0;
    circuitBreaker.halfOpenCalls = 0;
    
    this.logger.info(`Circuit breaker CLOSED for ${circuitBreaker.key}`);
  }

  /**
   * Reset a circuit breaker
   */
  resetCircuitBreaker(key) {
    const circuitBreaker = this.circuitBreakers.get(key);
    if (circuitBreaker) {
      this.closeCircuitBreaker(circuitBreaker);
    }
  }

  /**
   * Execute with both retry and circuit breaker
   */
  async executeWithRetryAndCircuitBreaker(operationId, operation, config = {}) {
    const circuitBreakerKey = config.circuitBreakerKey || `operation_${operationId}`;
    
    // Add circuit breaker key to operation info for tracking
    const retryConfig = {
      ...config,
      circuitBreakerKey
    };
    
    return this.executeWithRetry(operationId, async (attempt) => {
      return this.executeWithCircuitBreaker(circuitBreakerKey, operation, config);
    }, retryConfig);
  }

  /**
   * Create compensating transaction for failure recovery
   */
  async executeWithCompensation(operationId, operation, compensationOperation, config = {}) {
    try {
      const result = await this.executeWithRetry(operationId, operation, config);
      return result;
      
    } catch (error) {
      this.logger.error(`Operation ${operationId} failed, executing compensation`);
      
      try {
        await compensationOperation(error);
        this.logger.info(`Compensation for ${operationId} completed successfully`);
      } catch (compensationError) {
        this.logger.error(`Compensation for ${operationId} failed:`, compensationError);
        // Don't throw compensation error, preserve original error
      }
      
      throw error;
    }
  }

  /**
   * Batch retry multiple operations
   */
  async executeBatchWithRetry(operations, config = {}) {
    const batchConfig = {
      concurrent: config.concurrent !== false, // Default to concurrent execution
      failFast: config.failFast === true, // Default to not fail fast
      ...config
    };
    
    if (batchConfig.concurrent) {
      // Execute all operations concurrently
      const promises = operations.map(({ id, operation, config: opConfig }) => 
        this.executeWithRetry(id, operation, { ...batchConfig, ...opConfig })
          .catch(error => ({ id, error }))
      );
      
      const results = await Promise.all(promises);
      
      if (batchConfig.failFast) {
        // Check for any errors
        const errors = results.filter(result => result.error);
        if (errors.length > 0) {
          throw new Error(`Batch operation failed: ${errors.map(e => `${e.id}: ${e.error.message}`).join(', ')}`);
        }
      }
      
      return results;
      
    } else {
      // Execute operations sequentially
      const results = [];
      
      for (const { id, operation, config: opConfig } of operations) {
        try {
          const result = await this.executeWithRetry(id, operation, { ...batchConfig, ...opConfig });
          results.push({ id, result });
        } catch (error) {
          results.push({ id, error });
          
          if (batchConfig.failFast) {
            throw error;
          }
        }
      }
      
      return results;
    }
  }

  /**
   * Get operation status
   */
  getOperationStatus(operationId) {
    const operation = this.activeRetries.get(operationId);
    if (!operation) {
      return null;
    }
    
    return {
      operationId: operation.operationId,
      status: operation.status,
      attempts: operation.attempts,
      startTime: operation.startTime,
      completedAt: operation.completedAt,
      lastError: operation.lastError ? {
        message: operation.lastError.message,
        code: operation.lastError.code
      } : null
    };
  }

  /**
   * Get circuit breaker status
   */
  getCircuitBreakerStatus(key) {
    const circuitBreaker = this.circuitBreakers.get(key);
    if (!circuitBreaker) {
      return null;
    }
    
    return {
      key: circuitBreaker.key,
      state: circuitBreaker.state,
      failureCount: circuitBreaker.failureCount,
      lastFailureTime: circuitBreaker.lastFailureTime,
      nextAttemptTime: circuitBreaker.nextAttemptTime,
      metrics: { ...circuitBreaker.metrics }
    };
  }

  /**
   * Get all circuit breaker statuses
   */
  getAllCircuitBreakerStatuses() {
    const statuses = {};
    
    for (const [key] of this.circuitBreakers.entries()) {
      statuses[key] = this.getCircuitBreakerStatus(key);
    }
    
    return statuses;
  }

  /**
   * Get retry manager metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      activeOperations: this.activeRetries.size,
      circuitBreakers: this.circuitBreakers.size,
      openCircuitBreakers: Array.from(this.circuitBreakers.values())
        .filter(cb => cb.state === 'OPEN').length
    };
  }

  /**
   * Cancel an active operation
   */
  cancelOperation(operationId) {
    const operation = this.activeRetries.get(operationId);
    if (operation && operation.status === 'running') {
      operation.status = 'cancelled';
      operation.completedAt = Date.now();
      
      this.logger.info(`Operation ${operationId} cancelled`);
      return true;
    }
    
    return false;
  }

  /**
   * Clean up completed operations
   */
  cleanupCompletedOperations() {
    const cutoffTime = Date.now() - (60 * 60 * 1000); // 1 hour ago
    let cleanedCount = 0;
    
    for (const [operationId, operation] of this.activeRetries.entries()) {
      if (operation.status !== 'running' && 
          operation.completedAt && 
          operation.completedAt < cutoffTime) {
        this.activeRetries.delete(operationId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      this.logger.debug(`Cleaned up ${cleanedCount} completed operations`);
    }
  }

  /**
   * Utility method for delays
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Shutdown the retry manager
   */
  shutdown() {
    this.logger.info('Shutting down retry manager...');
    
    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    
    // Cancel all active operations
    for (const operationId of this.activeRetries.keys()) {
      this.cancelOperation(operationId);
    }
    
    // Clear all data
    this.activeRetries.clear();
    this.circuitBreakers.clear();
    
    this.logger.info('Retry manager shut down complete');
  }
}

module.exports = RetryManager;