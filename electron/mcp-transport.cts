import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

type StreamableHttpTransport =
  | StreamableHTTPClientTransport
  | StreamableHTTPServerTransport;

/**
 * Adapts the SDK's concrete streamable HTTP transports to its own public
 * Transport interface when exactOptionalPropertyTypes is enabled. The two
 * concrete transports currently expose disjoint send-option subsets.
 */
export class McpTransportAdapter implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: NonNullable<Transport['onmessage']>;

  constructor(private readonly transport: StreamableHttpTransport) {
    if (transport.onclose) this.onclose = transport.onclose;
    if (transport.onerror) this.onerror = transport.onerror;
    if (transport.onmessage) this.onmessage = transport.onmessage;
    // `Transport.sessionId?` is not compatible with the SDK concrete
    // transports under exactOptionalPropertyTypes: their getter returns
    // `string | undefined`. Install the optional runtime getter without
    // falsely declaring that it is always a string on this class.
    Object.defineProperty(this, 'sessionId', {
      configurable: true,
      enumerable: true,
      get: () => this.transport.sessionId,
    });
  }

  setProtocolVersion(version: string): void {
    if (this.transport instanceof StreamableHTTPClientTransport) {
      this.transport.setProtocolVersion(version);
    }
  }

  getSessionId(): string | undefined {
    return this.transport.sessionId;
  }

  async start(): Promise<void> {
    this.transport.onclose = () => this.onclose?.();
    this.transport.onerror = (error) => this.onerror?.(error);
    this.transport.onmessage = (message, extra) =>
      this.onmessage?.(message, extra);
    await this.transport.start();
  }

  send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    if (this.transport instanceof StreamableHTTPServerTransport) {
      const relatedRequestId = options?.relatedRequestId;
      return this.transport.send(
        message,
        relatedRequestId === undefined ? undefined : { relatedRequestId },
      );
    }
    const resumptionToken = options?.resumptionToken;
    const onresumptiontoken = options?.onresumptiontoken;
    return this.transport.send(message, {
      ...(resumptionToken === undefined ? {} : { resumptionToken }),
      ...(onresumptiontoken === undefined ? {} : { onresumptiontoken }),
    });
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}
