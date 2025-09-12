/**
 * CLI-Server Adapter - Handles communication between CLI tool and Node.js server
 * Provides REST API and WebSocket interfaces for CLI interactions
 */

const express = require('express');
const WebSocket = require('ws');
const { EventTypes, EventValidator } = require('../communication/event-schemas');

class CliServerAdapter {
  constructor(options = {}) {
    this.port = options.port || 8080;
    this.wsPort = options.wsPort || 8081;
    this.logger = options.logger || console;
    this.eventRouter = options.eventRouter;
    this.correlationTracker = options.correlationTracker;
    
    this.validator = new EventValidator();
    this.app = express();
    this.server = null;
    this.wsServer = null;
    this.wsConnections = new Map();
    
    // Request tracking
    this.activeRequests = new Map();
    this.requestHistory = [];
    this.maxHistorySize = 1000;
    
    this.setupExpressApp();
    this.setupWebSocketServer();
  }

  /**
   * Setup Express application
   */
  setupExpressApp() {
    // Middleware
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true }));
    
    // CORS
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Correlation-ID');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });
    
    // Request logging
    this.app.use((req, res, next) => {
      const correlationId = req.headers['x-correlation-id'] || this.generateCorrelationId();
      req.correlationId = correlationId;
      res.set('X-Correlation-ID', correlationId);
      
      this.logger.info(`${req.method} ${req.path} - Correlation: ${correlationId}`);
      next();
    });
    
    // Routes
    this.setupRoutes();
    
    // Error handling
    this.app.use(this.errorHandler.bind(this));
  }

  /**
   * Setup API routes
   */
  setupRoutes() {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        correlationId: req.correlationId
      });
    });
    
    // Generate image - Primary endpoint
    this.app.post('/api/generate-image', this.handleImageGeneration.bind(this));
    
    // Get generation status
    this.app.get('/api/status/:requestId', this.handleStatusCheck.bind(this));
    
    // List active requests
    this.app.get('/api/requests', this.handleListRequests.bind(this));
    
    // Cancel request
    this.app.delete('/api/requests/:requestId', this.handleCancelRequest.bind(this));
    
    // Get correlation trace
    this.app.get('/api/trace/:correlationId', this.handleGetTrace.bind(this));
    
    // System metrics
    this.app.get('/api/metrics', this.handleGetMetrics.bind(this));
    
    // Shutdown
    this.app.post('/api/shutdown', this.handleShutdown.bind(this));
  }

  /**
   * Handle image generation request
   */
  async handleImageGeneration(req, res) {
    try {
      const requestId = this.generateRequestId();
      const correlationId = req.correlationId;
      
      // Validate request
      const requestData = {
        requestId,
        correlationId,
        ...req.body
      };
      
      // Create and validate event
      const event = this.validator.createEvent(EventTypes.IMAGE_GENERATION_REQUESTED, requestData);
      
      // Track request
      this.trackRequest(requestId, correlationId, event, res);
      
      // Route event through the system
      if (this.eventRouter) {
        await this.eventRouter.routeEvent(event, 'cli');
      }
      
      // Create correlation trace
      if (this.correlationTracker) {
        this.correlationTracker.createCorrelation({
          requestId,
          source: 'cli',
          type: 'image_generation',
          prompt: req.body.prompt
        });
        this.correlationTracker.trackRequest(correlationId, {
          requestId,
          component: 'cli-adapter',
          method: 'POST',
          endpoint: '/api/generate-image',
          payload: req.body
        });
      }
      
      // Immediate response
      res.json({
        requestId,
        correlationId,
        status: 'accepted',
        message: 'Image generation request accepted',
        timestamp: new Date().toISOString(),
        websocketUrl: `ws://localhost:${this.wsPort}/ws?requestId=${requestId}`
      });
      
    } catch (error) {
      this.logger.error('Error handling image generation:', error);
      res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: error.message,
          correlationId: req.correlationId
        }
      });
    }
  }

  /**
   * Handle status check
   */
  async handleStatusCheck(req, res) {
    try {
      const { requestId } = req.params;
      const request = this.activeRequests.get(requestId);
      
      if (!request) {
        // Check history
        const historicalRequest = this.requestHistory.find(r => r.requestId === requestId);
        if (historicalRequest) {
          return res.json({
            requestId,
            status: historicalRequest.finalStatus || 'completed',
            completedAt: historicalRequest.completedAt,
            result: historicalRequest.result
          });
        }
        
        return res.status(404).json({
          error: {
            code: 'REQUEST_NOT_FOUND',
            message: `Request ${requestId} not found`,
            correlationId: req.correlationId
          }
        });
      }
      
      // Get latest status from correlation tracker
      let traceInfo = null;
      if (this.correlationTracker && request.correlationId) {
        const trace = this.correlationTracker.getTrace(request.correlationId);
        if (trace) {
          traceInfo = {
            currentStep: trace.currentStep,
            eventCount: trace.eventCount,
            errorCount: trace.errorCount,
            processingTime: Date.now() - trace.startTime
          };
        }
      }
      
      res.json({
        requestId,
        correlationId: request.correlationId,
        status: request.status,
        createdAt: request.createdAt,
        lastUpdate: request.lastUpdate,
        trace: traceInfo
      });
      
    } catch (error) {
      this.logger.error('Error checking status:', error);
      res.status(500).json({
        error: {
          code: 'STATUS_CHECK_ERROR',
          message: error.message,
          correlationId: req.correlationId
        }
      });
    }
  }

  /**
   * Handle list active requests
   */
  handleListRequests(req, res) {
    const requests = Array.from(this.activeRequests.values()).map(request => ({
      requestId: request.requestId,
      correlationId: request.correlationId,
      status: request.status,
      createdAt: request.createdAt,
      lastUpdate: request.lastUpdate,
      prompt: request.event.prompt
    }));
    
    res.json({
      activeRequests: requests,
      totalActive: requests.length,
      correlationId: req.correlationId
    });
  }

  /**
   * Handle cancel request
   */
  async handleCancelRequest(req, res) {
    try {
      const { requestId } = req.params;
      const request = this.activeRequests.get(requestId);
      
      if (!request) {
        return res.status(404).json({
          error: {
            code: 'REQUEST_NOT_FOUND',
            message: `Request ${requestId} not found`,
            correlationId: req.correlationId
          }
        });
      }
      
      // Update request status
      request.status = 'cancelled';
      request.lastUpdate = new Date();
      
      // Send cancellation event
      const cancelEvent = this.validator.createEvent(EventTypes.CLI_SHUTDOWN_REQUESTED, {
        requestId,
        correlationId: request.correlationId,
        reason: 'User cancellation'
      });
      
      if (this.eventRouter) {
        await this.eventRouter.routeEvent(cancelEvent, 'cli');
      }
      
      // Move to history
      this.moveRequestToHistory(requestId, 'cancelled');
      
      res.json({
        requestId,
        status: 'cancelled',
        message: 'Request cancelled successfully',
        correlationId: req.correlationId
      });
      
    } catch (error) {
      this.logger.error('Error cancelling request:', error);
      res.status(500).json({
        error: {
          code: 'CANCEL_ERROR',
          message: error.message,
          correlationId: req.correlationId
        }
      });
    }
  }

  /**
   * Handle get correlation trace
   */
  handleGetTrace(req, res) {
    try {
      const { correlationId } = req.params;
      
      if (!this.correlationTracker) {
        return res.status(503).json({
          error: {
            code: 'CORRELATION_TRACKING_DISABLED',
            message: 'Correlation tracking is not enabled',
            correlationId: req.correlationId
          }
        });
      }
      
      const trace = this.correlationTracker.generateReport(correlationId);
      
      if (!trace) {
        return res.status(404).json({
          error: {
            code: 'TRACE_NOT_FOUND',
            message: `Trace ${correlationId} not found`,
            correlationId: req.correlationId
          }
        });
      }
      
      res.json(trace);
      
    } catch (error) {
      this.logger.error('Error getting trace:', error);
      res.status(500).json({
        error: {
          code: 'TRACE_ERROR',
          message: error.message,
          correlationId: req.correlationId
        }
      });
    }
  }

  /**
   * Handle get metrics
   */
  handleGetMetrics(req, res) {
    const metrics = {
      adapter: {
        activeRequests: this.activeRequests.size,
        totalProcessed: this.requestHistory.length,
        wsConnections: this.wsConnections.size
      },
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
      }
    };
    
    if (this.correlationTracker) {
      metrics.correlationTracker = this.correlationTracker.getMetrics();
    }
    
    if (this.eventRouter) {
      metrics.eventRouter = this.eventRouter.getComponentStats();
    }
    
    res.json(metrics);
  }

  /**
   * Handle shutdown
   */
  async handleShutdown(req, res) {
    try {
      res.json({
        message: 'Shutdown initiated',
        activeRequests: this.activeRequests.size,
        correlationId: req.correlationId
      });
      
      // Graceful shutdown with delay
      setTimeout(() => {
        this.shutdown();
      }, 1000);
      
    } catch (error) {
      this.logger.error('Error during shutdown:', error);
      res.status(500).json({
        error: {
          code: 'SHUTDOWN_ERROR',
          message: error.message,
          correlationId: req.correlationId
        }
      });
    }
  }

  /**
   * Setup WebSocket server
   */
  setupWebSocketServer() {
    this.wsServer = new WebSocket.Server({ 
      port: this.wsPort,
      path: '/ws'
    });
    
    this.wsServer.on('connection', (ws, req) => {
      this.handleWebSocketConnection(ws, req);
    });
    
    this.wsServer.on('error', (error) => {
      this.logger.error('WebSocket server error:', error);
    });
  }

  /**
   * Handle WebSocket connection
   */
  handleWebSocketConnection(ws, req) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const requestId = url.searchParams.get('requestId');
    const connectionId = this.generateConnectionId();
    
    this.logger.info(`WebSocket connected: ${connectionId} (requestId: ${requestId})`);
    
    // Store connection
    this.wsConnections.set(connectionId, {
      ws,
      requestId,
      connectedAt: new Date(),
      lastActivity: new Date()
    });
    
    // Send welcome message
    ws.send(JSON.stringify({
      type: 'welcome',
      connectionId,
      requestId,
      timestamp: new Date().toISOString()
    }));
    
    // Handle messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        this.handleWebSocketMessage(connectionId, message);
      } catch (error) {
        this.logger.error(`WebSocket message error (${connectionId}):`, error);
      }
    });
    
    // Handle disconnect
    ws.on('close', () => {
      this.logger.info(`WebSocket disconnected: ${connectionId}`);
      this.wsConnections.delete(connectionId);
    });
    
    // Handle errors
    ws.on('error', (error) => {
      this.logger.error(`WebSocket error (${connectionId}):`, error);
    });
  }

  /**
   * Handle WebSocket message
   */
  async handleWebSocketMessage(connectionId, message) {
    const connection = this.wsConnections.get(connectionId);
    if (!connection) return;
    
    connection.lastActivity = new Date();
    
    try {
      switch (message.type) {
        case 'ping':
          connection.ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
          break;
          
        case 'subscribe':
          // Subscribe to specific events for this connection
          connection.subscriptions = message.eventTypes || ['*'];
          connection.ws.send(JSON.stringify({ 
            type: 'subscribed', 
            eventTypes: connection.subscriptions 
          }));
          break;
          
        default:
          this.logger.warn(`Unknown WebSocket message type: ${message.type}`);
      }
    } catch (error) {
      this.logger.error(`Error handling WebSocket message:`, error);
    }
  }

  /**
   * Broadcast event to WebSocket clients
   */
  broadcastEvent(event, requestId = null) {
    for (const [connectionId, connection] of this.wsConnections.entries()) {
      try {
        // Filter by request ID if specified
        if (requestId && connection.requestId !== requestId) {
          continue;
        }
        
        // Check subscription
        if (connection.subscriptions && 
            !connection.subscriptions.includes('*') && 
            !connection.subscriptions.includes(event.eventType)) {
          continue;
        }
        
        // Send event
        connection.ws.send(JSON.stringify({
          type: 'event',
          event,
          timestamp: new Date().toISOString()
        }));
        
      } catch (error) {
        this.logger.error(`Error broadcasting to ${connectionId}:`, error);
      }
    }
  }

  /**
   * Track a request
   */
  trackRequest(requestId, correlationId, event, response) {
    this.activeRequests.set(requestId, {
      requestId,
      correlationId,
      event,
      response,
      status: 'processing',
      createdAt: new Date(),
      lastUpdate: new Date()
    });
  }

  /**
   * Update request status
   */
  updateRequestStatus(requestId, status, result = null) {
    const request = this.activeRequests.get(requestId);
    if (request) {
      request.status = status;
      request.lastUpdate = new Date();
      if (result) {
        request.result = result;
      }
      
      // Broadcast status update
      this.broadcastEvent({
        eventType: EventTypes.STATUS_UPDATE,
        requestId,
        correlationId: request.correlationId,
        status,
        timestamp: new Date().toISOString()
      }, requestId);
    }
  }

  /**
   * Complete a request
   */
  completeRequest(requestId, result) {
    const request = this.activeRequests.get(requestId);
    if (request) {
      this.updateRequestStatus(requestId, 'completed', result);
      this.moveRequestToHistory(requestId, 'completed', result);
    }
  }

  /**
   * Move request to history
   */
  moveRequestToHistory(requestId, finalStatus, result = null) {
    const request = this.activeRequests.get(requestId);
    if (request) {
      this.activeRequests.delete(requestId);
      
      const historyEntry = {
        ...request,
        finalStatus,
        result,
        completedAt: new Date()
      };
      
      this.requestHistory.unshift(historyEntry);
      
      // Limit history size
      if (this.requestHistory.length > this.maxHistorySize) {
        this.requestHistory = this.requestHistory.slice(0, this.maxHistorySize);
      }
    }
  }

  /**
   * Error handler middleware
   */
  errorHandler(error, req, res, next) {
    this.logger.error('Express error:', error);
    
    res.status(error.status || 500).json({
      error: {
        code: error.code || 'INTERNAL_ERROR',
        message: error.message || 'Internal server error',
        correlationId: req.correlationId
      }
    });
  }

  /**
   * Generate request ID
   */
  generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate correlation ID
   */
  generateCorrelationId() {
    return `corr_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate connection ID
   */
  generateConnectionId() {
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Start the adapter
   */
  async start() {
    return new Promise((resolve, reject) => {
      try {
        // Start HTTP server
        this.server = this.app.listen(this.port, () => {
          this.logger.info(`CLI-Server adapter listening on port ${this.port}`);
          this.logger.info(`WebSocket server listening on port ${this.wsPort}`);
          resolve();
        });
        
        this.server.on('error', reject);
        
        // Register with event router if available
        if (this.eventRouter) {
          this.eventRouter.registerComponent('cli', this, {
            type: 'cli-adapter',
            capabilities: ['http', 'websocket', 'image-generation']
          });
        }
        
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Shutdown the adapter
   */
  async shutdown() {
    this.logger.info('Shutting down CLI-Server adapter...');
    
    // Close WebSocket connections
    for (const [connectionId, connection] of this.wsConnections.entries()) {
      connection.ws.close();
    }
    this.wsConnections.clear();
    
    // Close WebSocket server
    if (this.wsServer) {
      this.wsServer.close();
    }
    
    // Close HTTP server
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(resolve);
      });
    }
    
    this.logger.info('CLI-Server adapter shut down complete');
  }

  /**
   * Handle events from other components
   */
  handleEvent(event) {
    // Broadcast relevant events to CLI clients
    const broadcastEvents = [
      EventTypes.IMAGE_GENERATED,
      EventTypes.WORKFLOW_COMPLETED,
      EventTypes.ERROR_OCCURRED,
      EventTypes.STATUS_UPDATE
    ];
    
    if (broadcastEvents.includes(event.eventType)) {
      this.broadcastEvent(event, event.requestId);
      
      // Update request status if applicable
      if (event.requestId) {
        switch (event.eventType) {
          case EventTypes.IMAGE_GENERATED:
            if (event.status === 'success') {
              this.completeRequest(event.requestId, event);
            } else {
              this.updateRequestStatus(event.requestId, 'failed', event);
              this.moveRequestToHistory(event.requestId, 'failed', event);
            }
            break;
          case EventTypes.WORKFLOW_COMPLETED:
            this.completeRequest(event.requestId, event);
            break;
          case EventTypes.ERROR_OCCURRED:
            this.updateRequestStatus(event.requestId, 'failed', event);
            this.moveRequestToHistory(event.requestId, 'failed', event);
            break;
        }
      }
    }
  }
}

module.exports = CliServerAdapter;