// Copyright 2025-today Semantest Team
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview WebSocket communication adapter for Semantest
 * @author Semantest Team
 * @module infrastructure/semantic-automation/websocket-communication
 */

import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { Event } from '@typescript-eda/domain';

/**
 * WebSocket message interface
 */
export interface WebSocketMessage {
  readonly type: string;
  readonly payload: Record<string, any>;
  readonly id?: string;
  readonly timestamp?: string;
}

/**
 * WebSocket connection state
 */
export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  ERROR = 'ERROR'
}

/**
 * WebSocket communication adapter for real-time bidirectional communication
 * Implements automatic reconnection, heartbeat, and message queuing
 */
export class WebSocketCommunicationAdapter {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly protocols?: string | string[];
  private state: ConnectionState = ConnectionState.DISCONNECTED;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private readonly reconnectDelay = 1000;
  private messageQueue: WebSocketMessage[] = [];
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly heartbeatIntervalMs = 30000;
  private readonly messageHandlers = new Map<string, (message: WebSocketMessage) => void>();
  private readonly eventHandlers = new Map<string, Function[]>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  /**
   * Connect to WebSocket server
   */
  async connect(): Promise<void> {
    if (this.state === ConnectionState.CONNECTING || this.state === ConnectionState.CONNECTED) {
      return;
    }

    this.state = ConnectionState.CONNECTING;
    
    try {
      this.ws = new WebSocket(this.url, this.protocols);
      this.setupEventHandlers();
      
      await this.waitForConnection();
      
      this.state = ConnectionState.CONNECTED;
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.flushMessageQueue();
      this.emit('connected');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.state = ConnectionState.ERROR;
      this.emit('error', { error: errorMessage });
      
      throw new Error(`Failed to connect to WebSocket: ${errorMessage}`);
    }
  }

  /**
   * Wait for WebSocket connection to be established
   */
  private waitForConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('WebSocket not initialized'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, 10000);

      this.ws.once('open', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.ws.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Setup WebSocket event handlers
   */
  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => this.handleOpen());
    this.ws.on('message', (data: WebSocket.RawData) => this.handleMessage(data));
    this.ws.on('close', (code: number, reason: Buffer) => this.handleClose(code, reason.toString()));
    this.ws.on('error', (error: Error) => this.handleError(error));
  }

  /**
   * Handle WebSocket open event
   */
  private handleOpen(): void {
    console.log('WebSocket connected');
  }

  /**
   * Handle WebSocket message event
   */
  private handleMessage(data: WebSocket.RawData): void {
    try {
      const message = JSON.parse(data.toString()) as WebSocketMessage;
      const handler = this.messageHandlers.get(message.type);
      if (handler) {
        handler(message);
      }
      this.emit('message', message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Error parsing WebSocket message:', errorMessage);
    }
  }

  /**
   * Handle WebSocket close event
   */
  private handleClose(code: number, reason: string): void {
    console.log(`WebSocket closed: ${code} - ${reason}`);
    this.state = ConnectionState.DISCONNECTED;
    this.stopHeartbeat();
    this.emit('disconnected', { code, reason });
    
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect();
    }
  }

  /**
   * Handle WebSocket error event
   */
  private handleError(error: Error): void {
    console.error('WebSocket error:', error.message);
    this.emit('error', { error: error.message });
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    this.state = ConnectionState.RECONNECTING;
    this.reconnectAttempts++;
    
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    setTimeout(() => {
      console.log(`Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
      this.connect().catch(error => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('Reconnection failed:', errorMessage);
      });
    }, delay);
  }

  /**
   * Send message through WebSocket
   */
  send(message: WebSocketMessage): void {
    const messageWithMetadata = {
      ...message,
      id: message.id || uuidv4(),
      timestamp: message.timestamp || new Date().toISOString()
    };

    if (this.state === ConnectionState.CONNECTED && this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(messageWithMetadata));
        this.emit('messageSent', messageWithMetadata);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('Error sending message:', errorMessage);
        this.messageQueue.push(messageWithMetadata);
      }
    } else {
      this.messageQueue.push(messageWithMetadata);
    }
  }

  /**
   * Flush message queue
   */
  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0 && this.state === ConnectionState.CONNECTED) {
      const message = this.messageQueue.shift();
      if (message) {
        this.send(message);
      }
    }
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    
    this.heartbeatInterval = setInterval(() => {
      if (this.state === ConnectionState.CONNECTED) {
        this.send({ type: 'ping', payload: {} });
      }
    }, this.heartbeatIntervalMs);
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Register message handler for specific message type
   */
  on(messageType: string, handler: (message: WebSocketMessage) => void): void {
    this.messageHandlers.set(messageType, handler);
  }

  /**
   * Unregister message handler
   */
  off(messageType: string): void {
    this.messageHandlers.delete(messageType);
  }

  /**
   * Register event handler
   */
  addEventListener(event: string, handler: Function): void {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.push(handler);
    this.eventHandlers.set(event, handlers);
  }

  /**
   * Emit event to all registered handlers
   */
  private emit(event: string, data?: any): void {
    const handlers = this.eventHandlers.get(event) || [];
    handlers.forEach(handler => {
      try {
        handler(data);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`Error in event handler for ${event}:`, errorMessage);
      }
    });
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.state = ConnectionState.DISCONNECTED;
    this.stopHeartbeat();
    
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    
    this.messageQueue = [];
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent auto-reconnect
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state === ConnectionState.CONNECTED && this.ws?.readyState === WebSocket.OPEN;
  }
}
