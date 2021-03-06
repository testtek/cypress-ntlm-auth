import { IContext } from "http-mitm-proxy";

import net from "net";
import http from "http";
import { toCompleteUrl } from "../util/url.converter";
import { CompleteUrl } from "../models/complete.url.model";
import { injectable, inject, interfaces } from "inversify";
import { IConfigServer } from "./interfaces/i.config.server";
import { IConfigStore } from "./interfaces/i.config.store";
import { IConnectionContextManager } from "./interfaces/i.connection.context.manager";
import { INtlmProxyMitm } from "./interfaces/i.ntlm.proxy.mitm";
import { INtlmManager } from "./interfaces/i.ntlm.manager";
import { IUpstreamProxyManager } from "./interfaces/i.upstream.proxy.manager";
import { TYPES } from "./dependency.injection.types";
import { IDebugLogger } from "../util/interfaces/i.debug.logger";
import { TLSSocket } from "tls";
import { AuthModeEnum } from "../models/auth.mode.enum";
import { INegotiateManager } from "./interfaces/i.negotiate.manager";
import { IWinSsoFacade } from "./interfaces/i.win-sso.facade";

const nodeCommon = require("_http_common");

let self: NtlmProxyMitm;

@injectable()
export class NtlmProxyMitm implements INtlmProxyMitm {
  private _configStore: IConfigStore;
  private _configServer: IConfigServer;
  private _connectionContextManager: IConnectionContextManager;
  private WinSsoFacade: interfaces.Newable<IWinSsoFacade>;
  private _negotiateManager: INegotiateManager;
  private _ntlmManager: INtlmManager;
  private _upstreamProxyManager: IUpstreamProxyManager;
  private _debug: IDebugLogger;
  private _ntlmProxyPort: string | undefined;

  constructor(
    @inject(TYPES.IConfigStore) configStore: IConfigStore,
    @inject(TYPES.IConfigServer) configServer: IConfigServer,
    @inject(TYPES.IConnectionContextManager)
    connectionContextManager: IConnectionContextManager,
    @inject(TYPES.NewableIWinSsoFacade)
    winSsoFacade: interfaces.Newable<IWinSsoFacade>,
    @inject(TYPES.INegotiateManager) negotiateManager: INegotiateManager,
    @inject(TYPES.INtlmManager) ntlmManager: INtlmManager,
    @inject(TYPES.IUpstreamProxyManager)
    upstreamProxyManager: IUpstreamProxyManager,
    @inject(TYPES.IDebugLogger) debug: IDebugLogger
  ) {
    this._configStore = configStore;
    this._configServer = configServer;
    this._connectionContextManager = connectionContextManager;
    this.WinSsoFacade = winSsoFacade;
    this._negotiateManager = negotiateManager;
    this._ntlmManager = ntlmManager;
    this._upstreamProxyManager = upstreamProxyManager;
    this._debug = debug;

    // Keep track of instance since methods will be triggered from HttpMitmProxy
    // events which means that 'this' is no longer the class instance
    self = this;
  }

  get NtlmProxyPort(): string {
    if (this._ntlmProxyPort !== undefined) {
      return this._ntlmProxyPort;
    }
    throw new Error("Cannot get ntlmProxyPort, port has not been set!");
  }
  set NtlmProxyPort(port: string) {
    if (port === "") {
      this._ntlmProxyPort = undefined;
    }
    this._ntlmProxyPort = port;
  }

  private filterChromeStartup(
    ctx: IContext,
    errno: string | undefined,
    errorKind: string
  ) {
    if (!ctx || !ctx.clientToProxyRequest || !errno) {
      return false;
    }
    let req = ctx.clientToProxyRequest;
    if (
      req.method === "HEAD" &&
      req.url === "/" &&
      req.headers.host &&
      req.headers.host.indexOf(".") === -1 &&
      (req.headers.host.indexOf(":") === -1 ||
        req.headers.host.indexOf(":80") !== -1) &&
      req.headers.host.indexOf("/") === -1 &&
      errorKind === "PROXY_TO_SERVER_REQUEST_ERROR" &&
      errno === "ENOTFOUND"
    ) {
      self._debug.log(
        "Chrome startup HEAD request detected (host: " +
          req.headers.host +
          "). Ignoring connection error."
      );
      return true;
    }
  }

  onError(ctx: IContext, error: NodeJS.ErrnoException, errorKind: string) {
    if (self.filterChromeStartup(ctx, error.code, errorKind)) {
      return;
    }
    let url =
      ctx && ctx.clientToProxyRequest ? ctx.clientToProxyRequest.url : "";
    self._debug.log(errorKind + " on " + url + ":", error);
  }

  private isConfigApiRequest(targetHost: CompleteUrl) {
    return targetHost.href.startsWith(self._configServer.configApiUrl);
  }

  onRequest(ctx: IContext, callback: (error?: NodeJS.ErrnoException) => void) {
    let targetHost = self.getTargetHost(ctx);
    if (targetHost) {
      let context = self._connectionContextManager.getConnectionContextFromClientSocket(
        ctx.clientToProxyRequest.socket
      );
      let useSso = self._configStore.useSso(targetHost);
      let useNtlm = useSso || self._configStore.exists(targetHost);
      if (context) {
        if (context.matchHostOrNew(targetHost) === false) {
          self._debug.log(
            "Existing client socket " +
              context.clientAddress +
              " received request to a different target, remove existing context"
          );
          self._connectionContextManager.removeAgent(
            "reuse",
            context.clientAddress
          );
          context = undefined;
        }
      }
      if (!context) {
        context = self._connectionContextManager.createConnectionContext(
          ctx.clientToProxyRequest.socket,
          ctx.isSSL,
          targetHost
        );
      }

      if (useNtlm) {
        self._debug.log(
          "Request to " +
            targetHost.href +
            " in registered NTLM Hosts" +
            (useSso ? " (using SSO)" : "")
        );
        ctx.proxyToServerRequestOptions.agent = context.agent;
        context.clearRequestBody();
        ctx.onRequestData(function(ctx, chunk, callback) {
          context!.addToRequestBody(chunk);
          return callback(undefined, chunk);
        });
      } else {
        if (self.isConfigApiRequest(targetHost)) {
          self._debug.log("Request to config API");
          ctx.proxyToServerRequestOptions.agent = self._connectionContextManager.getUntrackedAgent(
            targetHost
          );
        } else {
          self._debug.log("Request to " + targetHost.href + " - pass on");
          ctx.proxyToServerRequestOptions.agent = context.agent;
        }
      }
      return callback();
    } else {
      // The http-mitm-proxy cannot handle this scenario, if no target host header
      // is set it will get stuck in an infinite loop
      return callback(
        new Error(
          'Invalid request - Could not read "host" header or "host" header refers to this proxy'
        )
      );
    }
  }

  private isNtlmProxyAddress(hostUrl: CompleteUrl): boolean {
    return hostUrl.isLocalhost && hostUrl.port === self.NtlmProxyPort;
  }

  private getTargetHost(ctx: IContext): CompleteUrl | null {
    if (!ctx.clientToProxyRequest.headers.host) {
      self._debug.log(
        'Invalid request - Could not read "host" header from incoming request to proxy'
      );
      return null;
    }
    let host = ctx.clientToProxyRequest.headers.host;
    let hostUrl = toCompleteUrl(host, ctx.isSSL, true);
    if (self.isNtlmProxyAddress(hostUrl)) {
      self._debug.log("Invalid request - host header refers to this proxy");
      return null;
    }
    return hostUrl;
  }

  private getAuthMode(
    serverToProxyResponse: http.IncomingMessage,
    useSso: boolean
  ): AuthModeEnum {
    if (
      serverToProxyResponse.statusCode !== 401 ||
      !serverToProxyResponse.headers["www-authenticate"]
    ) {
      return AuthModeEnum.NotApplicable;
    }
    if (
      useSso &&
      self._negotiateManager.acceptsNegotiateAuthentication(
        serverToProxyResponse
      )
    ) {
      return AuthModeEnum.Negotiate;
    }
    if (self._ntlmManager.acceptsNtlmAuthentication(serverToProxyResponse)) {
      return AuthModeEnum.NTLM;
    }
    // TODO Basic auth
    return AuthModeEnum.NotSupported;
  }

  onResponse(ctx: IContext, callback: (error?: NodeJS.ErrnoException) => void) {
    let targetHost = self.getTargetHost(ctx);
    if (!targetHost) {
      return callback();
    }
    let useSso = self._configStore.useSso(targetHost);
    let useNtlm = useSso || self._configStore.exists(targetHost);
    if (!useNtlm) {
      return callback();
    }

    let context = self._connectionContextManager.getConnectionContextFromClientSocket(
      ctx.clientToProxyRequest.socket
    );

    if (context && context.isNewOrAuthenticated(targetHost)) {
      const authMode = self.getAuthMode(ctx.serverToProxyResponse, useSso);
      if (authMode === AuthModeEnum.NotApplicable) {
        return callback();
      }
      if (authMode === AuthModeEnum.NotSupported) {
        self._debug.log(
          "Received 401 with unsupported protocol in www-authenticate header.",
          ctx.serverToProxyResponse.headers["www-authenticate"],
          "Ignoring."
        );
        return callback();
      }

      // Grab PeerCertificate for NTLM channel binding
      if (ctx.isSSL) {
        let tlsSocket = ctx.serverToProxyResponse.connection as TLSSocket;
        let peerCert = tlsSocket.getPeerCertificate();
        // getPeerCertificate may return an empty object.
        // Validate that it has fingerprint256 attribute (added in Node 9.8.0)
        if ((peerCert as any).fingerprint256) {
          context.peerCert = peerCert;
        } else {
          self._debug.log(
            "Could not retrieve PeerCertificate for NTLM channel binding."
          );
        }
      }

      if (authMode === AuthModeEnum.Negotiate) {
        self._debug.log(
          "Received 401 with Negotiate in www-authenticate header. Starting handshake."
        );
        if (useSso) {
          context.winSso = new self.WinSsoFacade(
            "Negotiate",
            ctx.proxyToServerRequestOptions.host,
            context.peerCert
          );
        }
        self._negotiateManager.handshake(
          ctx,
          targetHost,
          context,
          (err?: NodeJS.ErrnoException, res?: http.IncomingMessage) =>
            self.handshakeCallback(ctx, err, res)
        );
      }
      if (authMode === AuthModeEnum.NTLM) {
        self._debug.log(
          "Received 401 with NTLM in www-authenticate header. Starting handshake."
        );
        if (useSso) {
          context.winSso = new self.WinSsoFacade(
            "NTLM",
            ctx.proxyToServerRequestOptions.host,
            context.peerCert
          );
        }
        self._ntlmManager.handshake(
          ctx,
          targetHost,
          context,
          useSso,
          (err?: NodeJS.ErrnoException, res?: http.IncomingMessage) =>
            self.handshakeCallback(ctx, err, res)
        );
      }
    } else {
      return callback();
    }
  }

  private handshakeCallback(
    ctx: IContext,
    err?: NodeJS.ErrnoException,
    res?: http.IncomingMessage
  ) {
    if (err) {
      self._debug.log("Cannot perform handshake.");
    }
    if (res) {
      if (ctx.clientToProxyRequest.headers["proxy-connection"]) {
        res.headers["proxy-connection"] = "keep-alive";
        if (res.statusCode && res.statusCode !== 401) {
          res.headers["connection"] = "keep-alive";
        } else {
          res.headers["connection"] = "close";
        }
      }
      ctx.proxyToClientResponse.writeHead(
        res.statusCode || 401,
        self.filterAndCanonizeHeaders(res.headers)
      );
      res.on("data", chunk => ctx.proxyToClientResponse.write(chunk));
      res.on("end", () => ctx.proxyToClientResponse.end());
      res.resume();
    } else {
      // No response available, send empty 401 with headers from initial response
      let headers = ctx.serverToProxyResponse.headers;
      if (headers["proxy-connection"]) {
        headers["proxy-connection"] = "keep-alive";
        headers["connection"] = "close";
      }
      ctx.proxyToClientResponse.writeHead(
        401,
        self.filterAndCanonizeHeaders(headers)
      );
      ctx.proxyToClientResponse.end();
    }
  }

  onConnect(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: any,
    callback: (error?: NodeJS.ErrnoException) => void
  ) {
    if (!req.url) {
      self._debug.log("Invalid connect request - cannot read target url");
      return callback();
    }

    let targetHost = toCompleteUrl(req.url, true, true);
    if (self._configStore.existsOrUseSso(targetHost)) {
      return callback();
    }

    if (self._upstreamProxyManager.hasHttpsUpstreamProxy(targetHost)) {
      // Don't tunnel if we need to go through an upstream proxy
      return callback();
    }

    // Let non-NTLM hosts tunnel through
    self._debug.log("Tunnel to", req.url);
    let conn = net.connect(
      {
        port: +targetHost.port,
        host: targetHost.hostname,
        allowHalfOpen: true
      },
      function() {
        conn.on("finish", () => {
          self._connectionContextManager.removeTunnel(socket);
          socket.destroy();
        });
        socket.on("close", () => {
          self._debug.log("client closed socket, closing tunnel to ", req.url);
          conn.end();
        });

        socket.write("HTTP/1.1 200 OK\r\n\r\n", "UTF-8", function() {
          conn.write(head);
          conn.pipe(socket);
          socket.pipe(conn);
          self._connectionContextManager.addTunnel(socket, conn);
        });
      }
    );

    conn.on("error", function(err: NodeJS.ErrnoException) {
      filterSocketConnReset(err, "PROXY_TO_SERVER_SOCKET", req.url);
    });
    socket.on("error", function(err: NodeJS.ErrnoException) {
      filterSocketConnReset(err, "CLIENT_TO_PROXY_SOCKET", req.url);
    });

    // Since node 0.9.9, ECONNRESET on sockets are no longer hidden
    function filterSocketConnReset(
      err: NodeJS.ErrnoException,
      socketDescription: string,
      url: string | undefined
    ) {
      if (err.code === "ECONNRESET") {
        self._debug.log(
          "Got ECONNRESET on " +
            socketDescription +
            ", ignoring. Target: " +
            url
        );
      } else {
        self._debug.log(
          "Got unexpected error on " + socketDescription + ". Target: " + url,
          err
        );
      }
    }
  }

  private filterAndCanonizeHeaders(originalHeaders: http.IncomingHttpHeaders) {
    let headers: http.IncomingHttpHeaders = {};
    for (let key in originalHeaders) {
      let canonizedKey = key.trim();
      if (/^public\-key\-pins/i.test(canonizedKey)) {
        // HPKP header => filter
        continue;
      }

      if (!nodeCommon._checkInvalidHeaderChar(originalHeaders[key])) {
        headers[canonizedKey] = originalHeaders[key];
      }
    }

    return headers;
  }
}
