/**
 * Server-Extension Adapter - Handles communication between Node.js server and browser extension
 * Manages WebSocket connections and Chrome extension messaging
 */

const WebSocket = require('ws');
const { EventTypes, EventValidator } = require('../communication/event-schemas');

class ServerExtensionAdapter {
  constructor(options = {}) {
    this.port = options.port || 8082;
    this.logger = options.logger || console;
    this.eventRouter = options.eventRouter;
    this.correlationTracker = options.correlationTracker;
    
    this.validator = new EventValidator();
    this.wsServer = null;
    this.extensions = new Map(); // connectionId -> extension info
    
    // Extension session management
    this.sessions = new Map(); // sessionId -> session info
    this.sessionTimeouts = new Map();
    this.defaultSessionTimeout = 5 * 60 * 1000; // 5 minutes
    
    // Command queues for extensions
    this.commandQueues = new Map(); // extensionId -> command queue
    
    // Response tracking
    this.pendingResponses = new Map(); // commandId -> response callback
    this.responseTimeout = 30000; // 30 seconds
  }

  /**
   * Start the adapter
   */
  async start() {
    return new Promise((resolve, reject) => {
      try {
        this.wsServer = new WebSocket.Server({
          port: this.port,
          path: '/extension'
        });
        
        this.wsServer.on('connection', (ws, req) => {
          this.handleExtensionConnection(ws, req);
        });
        
        this.wsServer.on('error', (error) => {
          this.logger.error('Extension WebSocket server error:', error);
          reject(error);
        });
        
        this.logger.info(`Server-Extension adapter listening on port ${this.port}`);
        
        // Register with event router
        if (this.eventRouter) {
          this.eventRouter.registerComponent('extension-adapter', this, {
            type: 'extension-adapter',
            capabilities: ['websocket', 'chrome-extension', 'browser-automation']
          });
        }
        
        resolve();
        
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Handle new extension connection
   */
  handleExtensionConnection(ws, req) {
    const connectionId = this.generateConnectionId();
    const userAgent = req.headers['user-agent'] || 'unknown';
    
    this.logger.info(`Extension connected: ${connectionId}`);
    
    const extensionInfo = {
      connectionId,
      ws,
      connectedAt: new Date(),
      lastActivity: new Date(),
      userAgent,
      isAuthenticated: false,
      extensionId: null,
      capabilities: [],
      activeSessions: new Set(),
      messageCount: 0,
      errorCount: 0
    };
    
    this.extensions.set(connectionId, extensionInfo);
    
    // Send welcome message
    this.sendToExtension(connectionId, {
      type: 'welcome',
      connectionId,
      timestamp: new Date().toISOString(),
      requiresAuthentication: true
    });
    
    // Set up event handlers
    ws.on('message', (data) => {
      this.handleExtensionMessage(connectionId, data);
    });
    
    ws.on('close', () => {
      this.handleExtensionDisconnect(connectionId);
    });
    
    ws.on('error', (error) => {
      this.logger.error(`Extension error (${connectionId}):`, error);
      this.handleExtensionError(connectionId, error);
    });
    
    // Set connection timeout if not authenticated
    setTimeout(() => {
      const ext = this.extensions.get(connectionId);
      if (ext && !ext.isAuthenticated) {
        this.logger.warn(`Extension ${connectionId} not authenticated, closing connection`);
        ext.ws.close();
      }
    }, 30000); // 30 seconds to authenticate
  }

  /**
   * Handle message from extension
   */
  async handleExtensionMessage(connectionId, data) {
    const extension = this.extensions.get(connectionId);
    if (!extension) return;
    
    extension.lastActivity = new Date();
    extension.messageCount++;
    
    try {
      let message;
      if (typeof data === 'string') {
        message = JSON.parse(data);
      } else {
        message = data;
      }
      
      this.logger.debug(`Extension message (${connectionId}): ${message.type}`);
      
      switch (message.type) {
        case 'authenticate':
          await this.handleExtensionAuthentication(connectionId, message);
          break;
          
        case 'capability_report':
          this.handleCapabilityReport(connectionId, message);
          break;
          
        case 'session_started':
          this.handleSessionStarted(connectionId, message);
          break;
          
        case 'session_ended':
          this.handleSessionEnded(connectionId, message);
          break;
          
        case 'automation_complete':
          await this.handleAutomationComplete(connectionId, message);
          break;
          
        case 'automation_error':
          await this.handleAutomationError(connectionId, message);
          break;
          
        case 'image_generated':
          await this.handleImageGenerated(connectionId, message);
          break;
          
        case 'status_update':
          await this.handleStatusUpdate(connectionId, message);
          break;
          
        case 'command_response':
          this.handleCommandResponse(connectionId, message);
          break;
          
        case 'ping':
          this.sendToExtension(connectionId, { type: 'pong', timestamp: new Date().toISOString() });
          break;
          
        default:
          this.logger.warn(`Unknown message type from extension ${connectionId}: ${message.type}`);
      }
      
    } catch (error) {
      this.logger.error(`Error processing extension message (${connectionId}):`, error);
      extension.errorCount++;
    }
  }

  /**
   * Handle extension authentication
   */
  async handleExtensionAuthentication(connectionId, message) {
    const extension = this.extensions.get(connectionId);
    if (!extension) return;
    
    try {
      // Validate authentication data
      const { extensionId, version, capabilities, manifest } = message;
      
      if (!extensionId || !version) {
        throw new Error('Missing required authentication data');
      }
      
      // Update extension info
      extension.isAuthenticated = true;
      extension.extensionId = extensionId;
      extension.version = version;
      extension.capabilities = capabilities || [];
      extension.manifest = manifest;
      
      this.logger.info(`Extension authenticated: ${extensionId} v${version} (${connectionId})`);
      
      // Send authentication success
      this.sendToExtension(connectionId, {
        type: 'authentication_success',
        connectionId,
        welcomeMessage: 'Extension authenticated successfully',
        serverCapabilities: [
          'automation_orchestration',
          'session_management',
          'image_generation',
          'correlation_tracking'
        ]
      });
      
      // Initialize command queue
      this.commandQueues.set(extensionId, []);
      
    } catch (error) {
      this.logger.error(`Authentication failed for ${connectionId}:`, error);
      
      this.sendToExtension(connectionId, {
        type: 'authentication_failed',
        error: error.message
      });
      
      // Close connection after failed authentication
      setTimeout(() => {
        extension.ws.close();
      }, 1000);
    }
  }

  /**
   * Handle capability report
   */
  handleCapabilityReport(connectionId, message) {
    const extension = this.extensions.get(connectionId);
    if (!extension || !extension.isAuthenticated) return;
    
    extension.capabilities = message.capabilities || [];
    this.logger.debug(`Extension ${extension.extensionId} capabilities: ${extension.capabilities.join(', ')}`);
  }

  /**
   * Handle session started
   */
  handleSessionStarted(connectionId, message) {
    const extension = this.extensions.get(connectionId);
    if (!extension || !extension.isAuthenticated) return;
    
    const { sessionId, domainName, tabId } = message;
    
    const sessionInfo = {
      sessionId,
      extensionId: extension.extensionId,
      connectionId,
      domainName,
      tabId,
      startedAt: new Date(),
      lastActivity: new Date(),
      status: 'active',
      commands: [],
      correlationId: message.correlationId
    };
    
    this.sessions.set(sessionId, sessionInfo);
    extension.activeSessions.add(sessionId);
    
    // Set session timeout
    this.setSessionTimeout(sessionId);
    
    this.logger.info(`Session started: ${sessionId} on ${domainName} (${extension.extensionId})`);
    
    // Track in correlation if available
    if (this.correlationTracker && message.correlationId) {
      this.correlationTracker.trackRequest(message.correlationId, {
        requestId: sessionId,
        component: 'extension',
        method: 'SESSION_START',
        endpoint: domainName,
        payload: { tabId, extensionId: extension.extensionId }
      });
    }
  }

  /**
   * Handle session ended
   */
  handleSessionEnded(connectionId, message) {
    const extension = this.extensions.get(connectionId);
    if (!extension || !extension.isAuthenticated) return;
    
    const { sessionId, reason, result } = message;
    const session = this.sessions.get(sessionId);
    
    if (session) {
      session.status = 'ended';
      session.endedAt = new Date();
      session.endReason = reason;
      session.result = result;
      
      extension.activeSessions.delete(sessionId);
      this.clearSessionTimeout(sessionId);
      
      this.logger.info(`Session ended: ${sessionId} (${reason})`);
      
      // Clean up session after some time
      setTimeout(() => {
        this.sessions.delete(sessionId);
      }, 60000); // Keep for 1 minute for potential queries
    }
  }

  /**
   * Handle automation complete
   */
  async handleAutomationComplete(connectionId, message) {
    const extension = this.extensions.get(connectionId);
    if (!extension || !extension.isAuthenticated) return;
    
    const { sessionId, commandId, result, correlationId } = message;
    
    // Update session
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
      session.commands.push({
        commandId,
        type: 'automation_complete',
        timestamp: new Date(),
        result
      });
    }
    
    // Create completion event
    const completionEvent = this.validator.createEvent(EventTypes.STATUS_UPDATE, {
      component: 'extension',
      correlationId,
      requestId: sessionId,
      status: 'completed',
      message: 'Automation completed successfully',
      metadata: {
        extensionId: extension.extensionId,
        commandId,
        result
      }
    });
    
    // Route event
    if (this.eventRouter) {
      await this.eventRouter.routeEvent(completionEvent, 'extension');
    }
    
    this.logger.info(`Automation completed: ${commandId} in session ${sessionId}`);
  }

  /**
   * Handle automation error
   */
  async handleAutomationError(connectionId, message) {
    const extension = this.extensions.get(connectionId);
    if (!extension || !extension.isAuthenticated) return;
    
    const { sessionId, commandId, error, correlationId } = message;
    
    extension.errorCount++;
    
    // Update session
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
      session.commands.push({
        commandId,
        type: 'automation_error',
        timestamp: new Date(),
        error
      });
    }
    
    // Create error event
    const errorEvent = this.validator.createEvent(EventTypes.ERROR_OCCURRED, {
      component: 'extension',
      correlationId,
      requestId: sessionId,
      error: {
        code: error.code || 'EXTENSION_ERROR',
        message: error.message || 'Unknown extension error',
        details: {
          extensionId: extension.extensionId,
          commandId,
          sessionId,
          originalError: error
        },
        retryable: error.retryable !== false // Default to retryable
      }
    });
    
    // Route event
    if (this.eventRouter) {
      await this.eventRouter.routeEvent(errorEvent, 'extension');
    }
    
    this.logger.error(`Automation error: ${commandId} in session ${sessionId}: ${error.message}`);
  }

  /**
   * Handle image generated
   */
  async handleImageGenerated(connectionId, message) {
    const extension = this.extensions.get(connectionId);
    if (!extension || !extension.isAuthenticated) return;
    
    const { sessionId, requestId, correlationId, imageData } = message;
    
    // Create image generated event
    const imageEvent = this.validator.createEvent(EventTypes.IMAGE_GENERATED, {
      requestId,
      correlationId,
      status: imageData.success ? 'success' : 'failed',
      imageUrl: imageData.imageUrl,
      downloadPath: imageData.downloadPath,
      fileName: imageData.fileName,
      fileSize: imageData.fileSize,
      generationTime: imageData.generationTime,
      error: imageData.error,
      metadata: {
        extensionId: extension.extensionId,
        sessionId,
        domainName: imageData.domainName
      }
    });
    
    // Route event
    if (this.eventRouter) {
      await this.eventRouter.routeEvent(imageEvent, 'extension');
    }
    
    // Track in correlation
    if (this.correlationTracker && correlationId) {
      this.correlationTracker.trackEvent(correlationId, imageEvent);
    }
    
    this.logger.info(`Image generated: ${requestId} (${imageData.success ? 'success' : 'failed'})`);
  }

  /**
   * Handle status update
   */
  async handleStatusUpdate(connectionId, message) {
    const extension = this.extensions.get(connectionId);
    if (!extension || !extension.isAuthenticated) return;
    
    const { sessionId, status, progress, message: statusMessage, correlationId } = message;
    
    // Update session
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = new Date();
      session.currentStatus = status;
    }
    
    // Create status update event
    const statusEvent = this.validator.createEvent(EventTypes.STATUS_UPDATE, {
      component: 'extension',
      correlationId,
      requestId: sessionId,
      status,
      message: statusMessage,
      progress,
      metadata: {
        extensionId: extension.extensionId,
        sessionId
      }
    });
    
    // Route event
    if (this.eventRouter) {
      await this.eventRouter.routeEvent(statusEvent, 'extension');
    }
    }

  /**
   * Handle command response
   */
  handleCommandResponse(connectionId, message) {
    const { commandId, response, error } = message;
    
    const pendingResponse = this.pendingResponses.get(commandId);
    if (pendingResponse) {
      this.pendingResponses.delete(commandId);
      clearTimeout(pendingResponse.timeout);
      
      if (error) {
        pendingResponse.reject(new Error(error));
      } else {
        pendingResponse.resolve(response);
      }
    }
  }

  /**
   * Send command to extension and wait for response
   */
  async sendCommandToExtension(extensionId, command, timeout = this.responseTimeout) {
    const extension = this.findExtensionById(extensionId);
    if (!extension) {
      throw new Error(`Extension ${extensionId} not found or not connected`);
    }
    
    const commandId = this.generateCommandId();
    const commandWithId = {
      ...command,
      commandId,
      timestamp: new Date().toISOString()
    };
    
    return new Promise((resolve, reject) => {
      // Set up response handler
      const timeoutHandle = setTimeout(() => {
        this.pendingResponses.delete(commandId);
        reject(new Error(`Command timeout: ${command.type}`));
      }, timeout);
      
      this.pendingResponses.set(commandId, {
        resolve,
        reject,
        timeout: timeoutHandle
      });
      
      // Send command
      try {
        this.sendToExtension(extension.connectionId, commandWithId);
      } catch (error) {
        this.pendingResponses.delete(commandId);
        clearTimeout(timeoutHandle);
        reject(error);
      }
    });
  }

  /**
   * Send message to extension
   */
  sendToExtension(connectionId, message) {
    const extension = this.extensions.get(connectionId);
    if (!extension || extension.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Extension ${connectionId} not available`);
    }
    
    try {
      extension.ws.send(JSON.stringify(message));
    } catch (error) {
      this.logger.error(`Error sending to extension ${connectionId}:`, error);
      throw error;
    }
  }

  /**
   * Find extension by ID
   */
  findExtensionById(extensionId) {
    for (const extension of this.extensions.values()) {
      if (extension.extensionId === extensionId && extension.isAuthenticated) {
        return extension;
      }
    }
    return null;
  }

  /**
   * Get available extensions
   */
  getAvailableExtensions() {
    const extensions = [];
    
    for (const extension of this.extensions.values()) {
      if (extension.isAuthenticated) {
        extensions.push({
          extensionId: extension.extensionId,
          connectionId: extension.connectionId,
          version: extension.version,
          capabilities: extension.capabilities,
          activeSessions: extension.activeSessions.size,
          connectedAt: extension.connectedAt,
          lastActivity: extension.lastActivity
        });
Request      }
    }
    
    return extensions;
  }

  /**
   * Set session timeout
   */
  setSessionTimeout(sessionId) {
    this.clearSessionTimeout(sessionId);
    
    const timeout = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      if (session && session.status === 'active') {
        this.logger.warn(`Session ${sessionId} timed out`);
        
        // Notify extension of timeout
        try {
          this.sendToExtension(session.connectionId, {
            type: 'session_timeout',
            sessionId
          });
        } catch (error) {
          // Extension might be disconnected
        }
        
        // End session
        this.handleSessionEnded(session.connectionId, {
          sessionId,
          reason: 'timeout'
        });
      }
    }, this.defaultSessionTimeout);
    
    this.sessionTimeouts.set(sessionId, timeout);
  }

  /**
   * Clear session timeout
   */
  clearSessionTimeout(sessionId) {
    const timeout = this.sessionTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.sessionTimeouts.delete(sessionId);
    }
  }

  /**
   * Handle extension disconnect
   */
  handleExtensionDisconnect(connectionId) {
    const extension = this.extensions.get(connectionId);
    if (!extension) return;
    
    this.logger.info(`Extension disconnected: ${extension.extensionId || connectionId}`);
    
    // Clean up active sessions
    for (const sessionId of extension.activeSessions) {
      this.handleSessionEnded(connectionId, {
        sessionId,
        reason: 'extension_disconnect'
      });
    }
    
    // Clean up command queue
    if (extension.extensionId) {
      this.commandQueues.delete(extension.extensionId);
    }
    
    // Remove extension
    this.extensions.delete(connectionId);
  }

  /**
   * Handle extension error
   */
  handleExtensionError(connectionId, error) {
    const extension = this.extensions.get(connectionId);
    if (extension) {
      extension.errorCount++;
    }
    
    // Create error event if extension is authenticated
    if (extension && extension.isAuthenticated) {
      const errorEvent = this.validator.createEvent(EventTypes.ERROR_OCCURRED, {
        component: 'extension-adapter',
        error: {
          code: 'EXTENSION_CONNECTION_ERROR',
          message: error.message,
          details: {
            extensionId: extension.extensionId,
            connectionId
          }
        }
      });
      
      if (this.eventRouter) {
        this.eventRouter.routeEvent(errorEvent, 'extension');
      }
    }
  }

  /**
   * Handle events from other components
   */
  async handleEvent(event) {
    try {
      switch (event.eventType) {
        case EventTypes.EXTENSION_AUTOMATION_START:
          await this.handleAutomationStartEvent(event);
          break;
          
        case EventTypes.EXTENSION_PROMPT_INJECT:
          await this.handlePromptInjectEvent(event);
          break;
          
        case EventTypes.EXTENSION_IMAGE_CAPTURE:
          await this.handleImageCaptureEvent(event);
          break;
          
        case EventTypes.EXTENSION_SHUTDOWN:
          await this.handleExtensionShutdownEvent(event);
          break;
      }
    } catch (error) {
      this.logger.error(`Error handling event ${event.eventType}:`, error);
    }
  }

  /**
   * Handle automation start event
   */
  async handleAutomationStartEvent(event) {
    const { sessionId, domainName, timeout, correlationId } = event;
    
    // Find best extension for this domain
    const availableExtensions = this.getAvailableExtensions();
    const extension = availableExtensions.find(ext => 
      ext.capabilities.includes('chatgpt') || ext.capabilities.includes('general')
    ) || availableExtensions[0];
    
    if (!extension) {
      throw new Error('No suitable extension available for automation');
    }
    
    // Send automation start command
    const command = {
      type: 'start_automation',
      sessionId,
      domainName,
      timeout,
      correlationId
    };
    
    await this.sendCommandToExtension(extension.extensionId, command);
    
    this.logger.info(`Started automation session ${sessionId} on ${extension.extensionId}`);
  }

  /**
   * Handle prompt inject event
   */
  async handlePromptInjectEvent(event) {
    const { sessionId, prompt, model, quality, size, correlationId } = event;
    
    // Find session and extension
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    const extension = this.extensions.get(session.connectionId);
    if (!extension) {
      throw new Error(`Extension for session ${sessionId} not available`);
    }
    
    // Send prompt injection command
    const command = {
      type: 'inject_prompt',
      sessionId,
      prompt,
      model,
      quality,
      size,
      correlationId
    };
    
    await this.sendCommandToExtension(extension.extensionId, command);
    
    this.logger.info(`Injected prompt for session ${sessionId}`);
  }

  /**
   * Handle image capture event
   */
  async handleImageCaptureEvent(event) {
    const { sessionId, downloadPath, fileName, correlationId } = event;
    
    // Find session and extension
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    const extension = this.extensions.get(session.connectionId);
    if (!extension) {
      throw new Error(`Extension for session ${sessionId} not available`);
    }
    
    // Send image capture command
    const command = {
      type: 'capture_image',
      sessionId,
      downloadPath,
      fileName,
      correlationId
    };
    
    await this.sendCommandToExtension(extension.extensionId, command);
    
    this.logger.info(`Requested image capture for session ${sessionId}`);
  }

  /**
   * Handle extension shutdown event
   */
  async handleExtensionShutdownEvent(event) {
    const { reason, correlationId } = event;
    
    // Notify all extensions
    for (const extension of this.extensions.values()) {
      if (extension.isAuthenticated) {
        try {
          this.sendToExtension(extension.connectionId, {
            type: 'shutdown',
            reason,
            correlationId
          });
        } catch (error) {
          this.logger.warn(`Failed to notify extension ${extension.extensionId}:`, error.message);
        }
      }
    }
    
    this.logger.info(`Initiated extension shutdown: ${reason}`);
  }

  /**
   * Get adapter statistics
   */
  getStats() {
    return {
      connectedExtensions: this.extensions.size,
      authenticatedExtensions: Array.from(this.extensions.values()).filter(e => e.isAuthenticated).length,
      activeSessions: this.sessions.size,
      pendingResponses: this.pendingResponses.size,
      totalMessages: Array.from(this.extensions.values()).reduce((sum, e) => sum + e.messageCount, 0),
      totalErrors: Array.from(this.extensions.values()).reduce((sum, e) => sum + e.errorCount, 0)
    };
  }

  /**
   * Generate connection ID
   */
  generateConnectionId() {
    return `ext_conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate command ID
   */
  generateCommandId() {
    return `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Shutdown the adapter
   */
  async shutdown() {
    this.logger.info('Shutting down Server-Extension adapter...');
    
    // Clear all timeouts
    for (const timeout of this.sessionTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.sessionTimeouts.clear();
    
    // Clear pending responses
    for (const pending of this.pendingResponses.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Adapter shutting down'));
    }
    this.pendingResponses.clear();
    
    // Close all connections
    for (const extension of this.extensions.values()) {
      try {
        extension.ws.close();
      } catch (error) {
        // Ignore close errors
      }
    }
    this.extensions.clear();
    
    // Close WebSocket server
    if (this.wsServer) {
      this.wsServer.close();
    }
    
    // Clear data structures
    this.sessions.clear();
    this.commandQueues.clear();
    
    this.logger.info('Server-Extension adapter shut down complete');
  }
}

module.exports = ServerExtensionAdapter;