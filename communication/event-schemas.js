/**
 * Unified Event Schemas for ChatGPT Image Generation System
 * Defines all event types and their schemas across components
 */

const EventTypes = {
  // CLI → Server Events
  IMAGE_GENERATION_REQUESTED: 'ImageGenerationRequested',
  CLI_STATUS_CHECK: 'CliStatusCheck',
  CLI_SHUTDOWN_REQUESTED: 'CliShutdownRequested',

  // Server → Extension Events
  EXTENSION_AUTOMATION_START: 'ExtensionAutomationStart',
  EXTENSION_PROMPT_INJECT: 'ExtensionPromptInject',
  EXTENSION_IMAGE_CAPTURE: 'ExtensionImageCapture',
  EXTENSION_SHUTDOWN: 'ExtensionShutdown',

  // Server → Playwright Events
  PLAYWRIGHT_SESSION_START: 'PlaywrightSessionStart',
  PLAYWRIGHT_NAVIGATE: 'PlaywrightNavigate',
  PLAYWRIGHT_EXECUTE: 'PlaywrightExecute',
  PLAYWRIGHT_SCREENSHOT: 'PlaywrightScreenshot',

  // Response Events (all components → CLI)
  IMAGE_GENERATED: 'ImageGenerated',
  WORKFLOW_COMPLETED: 'WorkflowCompleted',
  ERROR_OCCURRED: 'ErrorOccurred',
  STATUS_UPDATE: 'StatusUpdate',

  // System Events
  CORRELATION_CREATED: 'CorrelationCreated',
  SAGA_STARTED: 'SagaStarted',
  SAGA_COMPLETED: 'SagaCompleted',
  COMPONENT_HEALTH_CHECK: 'ComponentHealthCheck'
};

const EventSchemas = {
  [EventTypes.IMAGE_GENERATION_REQUESTED]: {
    type: 'object',
    required: ['requestId', 'prompt', 'fileName', 'downloadFolder'],
    properties: {
      requestId: { type: 'string', minLength: 1 },
      correlationId: { type: 'string' },
      prompt: { type: 'string', minLength: 1 },
      fileName: { type: 'string', pattern: '^[^<>:"/\\|?*]+\\.(png|jpg|jpeg|gif|webp)$' },
      downloadFolder: { type: 'string', minLength: 1 },
      domainName: { type: 'string', default: 'chatgpt.com' },
      model: { type: 'string', enum: ['dall-e-3', 'dall-e-2'], default: 'dall-e-3' },
      quality: { type: 'string', enum: ['standard', 'hd'], default: 'standard' },
      size: { type: 'string', enum: ['1024x1024', '1792x1024', '1024x1792'], default: '1024x1024' },
      timeout: { type: 'number', minimum: 1000, default: 60000 },
      retryCount: { type: 'number', minimum: 0, default: 3 },
      metadata: { type: 'object' }
    }
  },

  [EventTypes.EXTENSION_AUTOMATION_START]: {
    type: 'object',
    required: ['sessionId', 'domainName'],
    properties: {
      sessionId: { type: 'string', minLength: 1 },
      correlationId: { type: 'string' },
      domainName: { type: 'string', minLength: 1 },
      userAgent: { type: 'string' },
      viewport: {
        type: 'object',
        properties: {
          width: { type: 'number', minimum: 100 },
          height: { type: 'number', minimum: 100 }
        }
      },
      timeout: { type: 'number', minimum: 1000, default: 30000 }
    }
  },

  [EventTypes.EXTENSION_PROMPT_INJECT]: {
    type: 'object',
    required: ['sessionId', 'prompt'],
    properties: {
      sessionId: { type: 'string', minLength: 1 },
      correlationId: { type: 'string' },
      prompt: { type: 'string', minLength: 1 },
      model: { type: 'string', enum: ['dall-e-3', 'dall-e-2'] },
      quality: { type: 'string', enum: ['standard', 'hd'] },
      size: { type: 'string' },
      waitForGeneration: { type: 'boolean', default: true },
      generationTimeout: { type: 'number', default: 120000 }
    }
  },

  [EventTypes.EXTENSION_IMAGE_CAPTURE]: {
    type: 'object',
    required: ['sessionId', 'downloadPath'],
    properties: {
      sessionId: { type: 'string', minLength: 1 },
      correlationId: { type: 'string' },
      downloadPath: { type: 'string', minLength: 1 },
      fileName: { type: 'string' },
      imageSelector: { type: 'string' },
      downloadTimeout: { type: 'number', default: 30000 }
    }
  },

  [EventTypes.PLAYWRIGHT_SESSION_START]: {
    type: 'object',
    required: ['sessionId', 'browserConfig'],
    properties: {
      sessionId: { type: 'string', minLength: 1 },
      correlationId: { type: 'string' },
      browserConfig: {
        type: 'object',
        properties: {
          browser: { type: 'string', enum: ['chromium', 'firefox', 'webkit'], default: 'chromium' },
          headless: { type: 'boolean', default: true },
          viewport: { type: 'object' },
          userAgent: { type: 'string' },
          timeout: { type: 'number', default: 30000 }
        }
      }
    }
  },

  [EventTypes.IMAGE_GENERATED]: {
    type: 'object',
    required: ['requestId', 'status'],
    properties: {
      requestId: { type: 'string', minLength: 1 },
      correlationId: { type: 'string' },
      status: { type: 'string', enum: ['success', 'failed', 'timeout'] },
      imageUrl: { type: 'string' },
      downloadPath: { type: 'string' },
      fileName: { type: 'string' },
      fileSize: { type: 'number' },
      generationTime: { type: 'number' },
      error: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          details: { type: 'object' }
        }
      },
      metadata: { type: 'object' }
    }
  },

  [EventTypes.ERROR_OCCURRED]: {
    type: 'object',
    required: ['component', 'error'],
    properties: {
      component: { type: 'string', enum: ['cli', 'server', 'extension', 'playwright'] },
      correlationId: { type: 'string' },
      requestId: { type: 'string' },
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          stack: { type: 'string' },
          details: { type: 'object' },
          retryable: { type: 'boolean', default: false }
        }
      },
      timestamp: { type: 'string', format: 'date-time' }
    }
  },

  [EventTypes.STATUS_UPDATE]: {
    type: 'object',
    required: ['component', 'status'],
    properties: {
      component: { type: 'string' },
      correlationId: { type: 'string' },
      requestId: { type: 'string' },
      status: { type: 'string', enum: ['initializing', 'processing', 'waiting', 'completed', 'failed'] },
      message: { type: 'string' },
      progress: { type: 'number', minimum: 0, maximum: 100 },
      timestamp: { type: 'string', format: 'date-time' },
      metadata: { type: 'object' }
    }
  }
};

// Event validation utility
class EventValidator {
  constructor() {
    this.schemas = EventSchemas;
  }

  validate(eventType, eventData) {
    const schema = this.schemas[eventType];
    if (!schema) {
      throw new Error(`Unknown event type: ${eventType}`);
    }

    const result = this.validateAgainstSchema(eventData, schema);
    if (!result.valid) {
      throw new Error(`Event validation failed: ${result.errors.join(', ')}`);
    }

    return true;
  }

  validateAgainstSchema(data, schema) {
    const errors = [];

    // Check required fields
    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in data)) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    // Check field types and constraints
    if (schema.properties) {
      for (const [field, fieldSchema] of Object.entries(schema.properties)) {
        if (field in data) {
          const fieldErrors = this.validateField(data[field], fieldSchema, field);
          errors.push(...fieldErrors);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  validateField(value, schema, fieldName) {
    const errors = [];

    // Type checking
    if (schema.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== schema.type) {
        errors.push(`Field ${fieldName} should be ${schema.type}, got ${actualType}`);
        return errors; // Skip further validation if type is wrong
      }
    }

    // String validations
    if (schema.type === 'string') {
      if (schema.minLength && value.length < schema.minLength) {
        errors.push(`Field ${fieldName} must be at least ${schema.minLength} characters`);
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        errors.push(`Field ${fieldName} does not match required pattern`);
      }
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push(`Field ${fieldName} must be one of: ${schema.enum.join(', ')}`);
      }
    }

    // Number validations
    if (schema.type === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`Field ${fieldName} must be at least ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`Field ${fieldName} must be at most ${schema.maximum}`);
      }
    }

    // Object validation (recursive)
    if (schema.type === 'object' && schema.properties) {
      const subResult = this.validateAgainstSchema(value, schema);
      errors.push(...subResult.errors.map(e => `${fieldName}.${e}`));
    }

    return errors;
  }

  // Create a valid event with defaults
  createEvent(eventType, eventData = {}) {
    const schema = this.schemas[eventType];
    if (!schema) {
      throw new Error(`Unknown event type: ${eventType}`);
    }

    const event = { ...eventData };

    // Apply defaults
    if (schema.properties) {
      for (const [field, fieldSchema] of Object.entries(schema.properties)) {
        if (!(field in event) && 'default' in fieldSchema) {
          event[field] = fieldSchema.default;
        }
      }
    }

    // Add standard metadata
    event.eventType = eventType;
    event.eventId = `${eventType}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    event.timestamp = new Date().toISOString();
    event.eventVersion = 1;

    this.validate(eventType, event);
    return event;
  }
}

module.exports = {
  EventTypes,
  EventSchemas,
  EventValidator
};