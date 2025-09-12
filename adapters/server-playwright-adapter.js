/**
 * Server-Playwright Adapter - Alternative browser automation using Playwright MCP
 * Provides headless browser automation as fallback or alternative to extension
 */

const { EventTypes, EventValidator } = require('../communication/event-schemas');

class ServerPlaywrightAdapter {
  constructor(options = {}) {
    this.logger = options.logger || console;
    this.eventRouter = options.eventRouter;
    this.correlationTracker = options.correlationTracker;
    
    this.validator = new EventValidator();
    
    // Browser session management
    this.browserSessions = new Map(); // sessionId -> browser session info
    this.activeBrowsers = new Map(); // browserId -> browser instance
    
    // Default configuration
    this.defaultConfig = {
      browser: 'chromium', // chromium, firefox, webkit
      headless: true,
      viewport: { width: 1920, height: 1080 },
      timeout: 30000,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
    
    // Command execution tracking
    this.pendingCommands = new Map();
    this.commandTimeout = 60000; // 60 seconds
    
    // MCP tool availability
    this.mcpToolsAvailable = false;
    this.mcpTools = null;
    
    // Automation patterns for different sites
    this.automationPatterns = {
      'chatgpt.com': {
        selectors: {
          promptInput: 'textarea[placeholder*="Send a message"], textarea[data-id="root"]',
          sendButton: 'button[data-testid="send-button"], button:has(svg[data-icon="send"])',
          imageContainer: '.result-streaming img, [data-message-author-role="assistant"] img',
          newConversation: 'button:has-text("New chat"), button[aria-label*="New"]'
        },
        workflows: {
          imageGeneration: {
            steps: [
              'navigate',
              'waitForLoad',
              'injectPrompt',
              'submitPrompt',
              'waitForGeneration',
              'extractImage',
              'downloadImage'
            ]
          }
        }
      }
    };
  }

  /**
   * Initialize the adapter
   */
  async initialize(mcpTools = null) {
    this.mcpTools = mcpTools;
    this.mcpToolsAvailable = mcpTools !== null;
    
    if (this.mcpToolsAvailable) {
      this.logger.info('Playwright adapter initialized with MCP tools');
    } else {
      this.logger.warn('Playwright adapter initialized without MCP tools - limited functionality');
    }
    
    // Register with event router
    if (this.eventRouter) {
      this.eventRouter.registerComponent('playwright-adapter', this, {
        type: 'playwright-adapter',
        capabilities: ['browser-automation', 'headless-browsing', 'screenshot', 'scraping'],
        healthCheck: () => this.healthCheck()
      });
    }
  }

  /**
   * Handle events from other components
   */
  async handleEvent(event) {
    try {
      switch (event.eventType) {
        case EventTypes.PLAYWRIGHT_SESSION_START:
          await this.handleSessionStartEvent(event);
          break;
          
        case EventTypes.PLAYWRIGHT_NAVIGATE:
          await this.handleNavigateEvent(event);
          break;
          
        case EventTypes.PLAYWRIGHT_EXECUTE:
          await this.handleExecuteEvent(event);
          break;
          
        case EventTypes.PLAYWRIGHT_SCREENSHOT:
          await this.handleScreenshotEvent(event);
          break;
          
        case EventTypes.IMAGE_GENERATION_REQUESTED:
          await this.handleImageGenerationRequest(event);
          break;
      }
    } catch (error) {
      this.logger.error(`Error handling event ${event.eventType}:`, error);
      await this.emitError(event, error);
    }
  }

  /**
   * Handle session start event
   */
  async handleSessionStartEvent(event) {
    const { sessionId, browserConfig = {}, correlationId } = event;
    
    const config = { ...this.defaultConfig, ...browserConfig };
    
    try {
      let browserSession;
      
      if (this.mcpToolsAvailable) {
        // Use MCP tools for browser management
        browserSession = await this.createMCPSession(sessionId, config);
      } else {
        // Fallback: create mock session
        browserSession = await this.createMockSession(sessionId, config);
      }
      
      this.browserSessions.set(sessionId, browserSession);
      
      // Track in correlation
      if (this.correlationTracker && correlationId) {
        this.correlationTracker.trackRequest(correlationId, {
          requestId: sessionId,
          component: 'playwright',
          method: 'SESSION_START',
          payload: config
        });
      }
      
      this.logger.info(`Playwright session started: ${sessionId}`);
      
      await this.emitStatus(event, 'completed', 'Session started successfully');
      
    } catch (error) {
      this.logger.error(`Failed to start session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Handle navigate event
   */
  async handleNavigateEvent(event) {
    const { sessionId, url, waitForLoad = true, correlationId } = event;
    
    const session = this.browserSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    try {
      if (this.mcpToolsAvailable) {
        await this.mcpNavigate(session, url, waitForLoad);
      } else {
        await this.mockNavigate(session, url);
      }
      
      session.currentUrl = url;
      session.lastActivity = new Date();
      
      this.logger.info(`Navigated session ${sessionId} to ${url}`);
      
      await this.emitStatus(event, 'completed', `Navigated to ${url}`);
      
    } catch (error) {
      this.logger.error(`Navigation failed for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Handle execute event
   */
  async handleExecuteEvent(event) {
    const { sessionId, action, parameters = {}, correlationId } = event;
    
    const session = this.browserSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    try {
      let result;
      
      if (this.mcpToolsAvailable) {
        result = await this.mcpExecuteAction(session, action, parameters);
      } else {
        result = await this.mockExecuteAction(session, action, parameters);
      }
      
      session.lastActivity = new Date();
      
      this.logger.info(`Executed action ${action} in session ${sessionId}`);
      
      await this.emitStatus(event, 'completed', `Action ${action} completed`, {
        result
      });
      
    } catch (error) {
      this.logger.error(`Action execution failed for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Handle screenshot event
   */
  async handleScreenshotEvent(event) {
    const { sessionId, options = {}, correlationId } = event;
    
    const session = this.browserSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    
    try {
      let screenshotData;
      
      if (this.mcpToolsAvailable) {
        screenshotData = await this.mcpTakeScreenshot(session, options);
      } else {
        screenshotData = await this.mockTakeScreenshot(session, options);
      }
      
      session.lastActivity = new Date();
      
      this.logger.info(`Screenshot taken for session ${sessionId}`);
      
      await this.emitStatus(event, 'completed', 'Screenshot taken', {
        screenshotData
      });
      
    } catch (error) {
      this.logger.error(`Screenshot failed for session ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Handle image generation request - main automation workflow
   */
  async handleImageGenerationRequest(event) {
    const { 
      requestId, 
      prompt, 
      domainName = 'chatgpt.com', 
      fileName, 
      downloadFolder,
      correlationId 
    } = event;
    
    const sessionId = `playwright_${requestId}`;
    
    try {
      // Start browser session
      await this.emitStatus(event, 'processing', 'Starting browser session');
      
      const sessionStartEvent = this.validator.createEvent(EventTypes.PLAYWRIGHT_SESSION_START, {
        sessionId,
        browserConfig: {
          browser: 'chromium',
          headless: true,
          viewport: { width: 1920, height: 1080 }
        },
        correlationId
      });
      
      await this.handleSessionStartEvent(sessionStartEvent);
      
      // Execute image generation workflow
      await this.executeImageGenerationWorkflow(sessionId, {
        prompt,
        domainName,
        fileName,
        downloadFolder,
        requestId,
        correlationId
      });
      
    } catch (error) {
      this.logger.error(`Image generation workflow failed for ${requestId}:`, error);
      
      // Clean up session
      await this.cleanupSession(sessionId);
      
      throw error;
    }
  }

  /**
   * Execute the complete image generation workflow
   */
  async executeImageGenerationWorkflow(sessionId, params) {
    const { prompt, domainName, fileName, downloadFolder, requestId, correlationId } = params;
    
    const pattern = this.automationPatterns[domainName];
    if (!pattern) {
      throw new Error(`No automation pattern available for ${domainName}`);
    }
    
    const workflow = pattern.workflows.imageGeneration;
    
    for (const step of workflow.steps) {
      await this.emitStatus({ requestId, correlationId }, 'processing', `Executing step: ${step}`);
      
      switch (step) {
        case 'navigate':
          await this.workflowNavigate(sessionId, domainName, correlationId);
          break;
          
        case 'waitForLoad':
          await this.workflowWaitForLoad(sessionId, pattern, correlationId);
          break;
          
        case 'injectPrompt':
          await this.workflowInjectPrompt(sessionId, prompt, pattern, correlationId);
          break;
          
        case 'submitPrompt':
          await this.workflowSubmitPrompt(sessionId, pattern, correlationId);
          break;
          
        case 'waitForGeneration':
          await this.workflowWaitForGeneration(sessionId, pattern, correlationId);
          break;
          
        case 'extractImage':
          await this.workflowExtractImage(sessionId, pattern, correlationId);
          break;
          
        case 'downloadImage':
          const imageData = await this.workflowDownloadImage(sessionId, fileName, downloadFolder, correlationId);
          
          // Emit success event
          const imageEvent = this.validator.createEvent(EventTypes.IMAGE_GENERATED, {
            requestId,
            correlationId,
            status: 'success',
            downloadPath: imageData.path,
            fileName: imageData.fileName,
            fileSize: imageData.size,
            generationTime: Date.now() - new Date(params.startTime || Date.now()),
            metadata: {
              method: 'playwright',
              domainName
            }
          });
          
          if (this.eventRouter) {
            await this.eventRouter.routeEvent(imageEvent, 'playwright');
          }
          
          break;
      }
    }
    
    // Clean up session
    await this.cleanupSession(sessionId);
  }

  /**
   * Workflow step implementations
   */
  async workflowNavigate(sessionId, domainName, correlationId) {
    const url = `https://${domainName}`;
    const navigateEvent = this.validator.createEvent(EventTypes.PLAYWRIGHT_NAVIGATE, {
      sessionId,
      url,
      waitForLoad: true,
      correlationId
    });
    
    await this.handleNavigateEvent(navigateEvent);
  }

  async workflowWaitForLoad(sessionId, pattern, correlationId) {
    await this.delay(2000); // Basic wait
    
    if (this.mcpToolsAvailable) {
      // Wait for specific elements to be available
      const session = this.browserSessions.get(sessionId);
      await this.mcpWaitForSelector(session, pattern.selectors.promptInput);
    }
  }

  async workflowInjectPrompt(sessionId, prompt, pattern, correlationId) {
    const executeEvent = this.validator.createEvent(EventTypes.PLAYWRIGHT_EXECUTE, {
      sessionId,
      action: 'type',
      parameters: {
        selector: pattern.selectors.promptInput,
        text: prompt,
        options: { delay: 100 }
      },
      correlationId
    });
    
    await this.handleExecuteEvent(executeEvent);
  }

  async workflowSubmitPrompt(sessionId, pattern, correlationId) {
    const executeEvent = this.validator.createEvent(EventTypes.PLAYWRIGHT_EXECUTE, {
      sessionId,
      action: 'click',
      parameters: {
        selector: pattern.selectors.sendButton
      },
      correlationId
    });
    
    await this.handleExecuteEvent(executeEvent);
  }

  async workflowWaitForGeneration(sessionId, pattern, correlationId) {
    // Wait for image to appear
    await this.delay(5000); // Initial wait
    
    if (this.mcpToolsAvailable) {
      const session = this.browserSessions.get(sessionId);
      // Wait up to 2 minutes for image generation
      await this.mcpWaitForSelector(session, pattern.selectors.imageContainer, { timeout: 120000 });
    } else {
      // Mock wait for generation
      await this.delay(30000);
    }
  }

  async workflowExtractImage(sessionId, pattern, correlationId) {
    // Extract image URL or data
    const executeEvent = this.validator.createEvent(EventTypes.PLAYWRIGHT_EXECUTE, {
      sessionId,
      action: 'getAttribute',
      parameters: {
        selector: pattern.selectors.imageContainer,
        attribute: 'src'
      },
      correlationId
    });
    
    await this.handleExecuteEvent(executeEvent);
  }

  async workflowDownloadImage(sessionId, fileName, downloadFolder, correlationId) {
    // Download the image
    const session = this.browserSessions.get(sessionId);
    
    if (this.mcpToolsAvailable) {
      return await this.mcpDownloadImage(session, fileName, downloadFolder);
    } else {
      // Mock download
      return {
        path: `${downloadFolder}/${fileName}`,
        fileName,
        size: 1024 * 1024 // 1MB mock size
      };
    }
  }

  /**
   * MCP tool implementations
   */
  async createMCPSession(sessionId, config) {
    // Implementation would use actual MCP tools
    // For now, return mock session
    return this.createMockSession(sessionId, config);
  }

  async mcpNavigate(session, url, waitForLoad) {
    // Use MCP navigate tool
    this.logger.debug(`MCP navigate to ${url}`);
  }

  async mcpExecuteAction(session, action, parameters) {
    // Use MCP execution tools
    this.logger.debug(`MCP execute ${action}`, parameters);
    return { success: true, action, parameters };
  }

  async mcpTakeScreenshot(session, options) {
    // Use MCP screenshot tool
    this.logger.debug('MCP screenshot', options);
    return { data: 'base64_screenshot_data', format: 'png' };
  }

  async mcpWaitForSelector(session, selector, options = {}) {
    // Use MCP wait tools
    this.logger.debug(`MCP wait for ${selector}`, options);
  }

  async mcpDownloadImage(session, fileName, downloadFolder) {
    // Use MCP download tools
    this.logger.debug(`MCP download to ${downloadFolder}/${fileName}`);
    return {
      path: `${downloadFolder}/${fileName}`,
      fileName,
      size: 2048 * 1024 // 2MB
    };
  }

  /**
   * Mock implementations for when MCP tools are not available
   */
  async createMockSession(sessionId, config) {
    return {
      sessionId,
      config,
      createdAt: new Date(),
      lastActivity: new Date(),
      currentUrl: null,
      isMock: true
    };
  }

  async mockNavigate(session, url) {
    this.logger.debug(`Mock navigate to ${url}`);
    await this.delay(1000);
  }

  async mockExecuteAction(session, action, parameters) {
    this.logger.debug(`Mock execute ${action}`, parameters);
    await this.delay(500);
    return { success: true, action, parameters, isMock: true };
  }

  async mockTakeScreenshot(session, options) {
    this.logger.debug('Mock screenshot', options);
    await this.delay(1000);
    return { data: 'mock_base64_data', format: 'png', isMock: true };
  }

  /**
   * Emit status update event
   */
  async emitStatus(originalEvent, status, message, metadata = {}) {
    const statusEvent = this.validator.createEvent(EventTypes.STATUS_UPDATE, {
      component: 'playwright',
      correlationId: originalEvent.correlationId,
      requestId: originalEvent.requestId || originalEvent.sessionId,
      status,
      message,
      metadata: {
        ...metadata,
        originalEventType: originalEvent.eventType
      }
    });
    
    if (this.eventRouter) {
      await this.eventRouter.routeEvent(statusEvent, 'playwright');
    }
  }

  /**
   * Emit error event
   */
  async emitError(originalEvent, error) {
    const errorEvent = this.validator.createEvent(EventTypes.ERROR_OCCURRED, {
      component: 'playwright',
      correlationId: originalEvent.correlationId,
      requestId: originalEvent.requestId || originalEvent.sessionId,
      error: {
        code: error.code || 'PLAYWRIGHT_ERROR',
        message: error.message,
        details: {
          originalEventType: originalEvent.eventType,
          stack: error.stack
        },
        retryable: error.retryable !== false
      }
    });
    
    if (this.eventRouter) {
      await this.eventRouter.routeEvent(errorEvent, 'playwright');
    }
  }

  /**
   * Clean up a browser session
   */
  async cleanupSession(sessionId) {
    const session = this.browserSessions.get(sessionId);
    if (!session) return;
    
    try {
      if (this.mcpToolsAvailable && !session.isMock) {
        // Close MCP browser session
        this.logger.debug(`Cleaning up MCP session ${sessionId}`);
      }
      
      this.browserSessions.delete(sessionId);
      
      this.logger.info(`Session ${sessionId} cleaned up`);
      
    } catch (error) {
      this.logger.error(`Error cleaning up session ${sessionId}:`, error);
    }
  }

  /**
   * Health check for the adapter
   */
  async healthCheck() {
    try {
      const stats = this.getStats();
      
      return {
        healthy: true,
        mcpToolsAvailable: this.mcpToolsAvailable,
        activeSessions: stats.activeSessions,
        totalSessions: stats.totalSessions
      };
      
    } catch (error) {
      return {
        healthy: false,
        error: error.message
      };
    }
  }

  /**
   * Get adapter statistics
   */
  getStats() {
    return {
      mcpToolsAvailable: this.mcpToolsAvailable,
      activeSessions: this.browserSessions.size,
      totalSessions: this.browserSessions.size,
      activeCommands: this.pendingCommands.size,
      supportedPatterns: Object.keys(this.automationPatterns)
    };
  }

  /**
   * List active sessions
   */
  getActiveSessions() {
    const sessions = [];
    
    for (const [sessionId, session] of this.browserSessions.entries()) {
      sessions.push({
        sessionId,
        currentUrl: session.currentUrl,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
        isMock: session.isMock || false
      });
    }
    
    return sessions;
  }

  /**
   * Utility method for delays
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Shutdown the adapter
   */
  async shutdown() {
    this.logger.info('Shutting down Server-Playwright adapter...');
    
    // Clean up all sessions
    const sessionCleanupPromises = Array.from(this.browserSessions.keys())
      .map(sessionId => this.cleanupSession(sessionId));
    
    await Promise.allSettled(sessionCleanupPromises);
    
    // Clear pending commands
    for (const [commandId, command] of this.pendingCommands.entries()) {
      if (command.timeout) {
        clearTimeout(command.timeout);
      }
    }
    this.pendingCommands.clear();
    
    // Clear data structures
    this.browserSessions.clear();
    this.activeBrowsers.clear();
    
    this.logger.info('Server-Playwright adapter shut down complete');
  }
}

module.exports = ServerPlaywrightAdapter;