import { NtlmStateEnum } from "../models/ntlm.state.enum";
import { CompleteUrl } from "../models/complete.url.model";
import { injectable } from "inversify";
import { IConnectionContext } from "./interfaces/i.connection.context";
import { PeerCertificate } from "tls";
import { IWinSsoFacade } from "./interfaces/i.win-sso.facade";

@injectable()
export class ConnectionContext implements IConnectionContext {
  private _agent: any;
  private _ntlmHost?: CompleteUrl;
  private _ntlmState: NtlmStateEnum = NtlmStateEnum.NotAuthenticated;
  private _requestBody = Buffer.alloc(0);
  private _winSso?: IWinSsoFacade;
  private _peerCert?: PeerCertificate;
  private _clientAddress = "";

  get agent(): any {
    return this._agent;
  }
  set agent(agent: any) {
    this._agent = agent;
  }

  get winSso(): IWinSsoFacade {
    if (!this._winSso) {
      throw new Error("WinSso not initialized for context");
    }
    return this._winSso;
  }
  set winSso(winSso: IWinSsoFacade) {
    this._winSso = winSso;
  }

  get peerCert(): PeerCertificate | undefined {
    return this._peerCert;
  }
  set peerCert(peerCert: PeerCertificate | undefined) {
    this._peerCert = peerCert;
  }

  get clientAddress(): string {
    return this._clientAddress;
  }
  set clientAddress(clientAddress: string) {
    this._clientAddress = clientAddress;
  }

  isNewOrAuthenticated(ntlmHostUrl: CompleteUrl): boolean {
    let auth =
      this._ntlmHost === undefined ||
      (this._ntlmHost !== undefined &&
        this._ntlmHost.href === ntlmHostUrl.href &&
        this._ntlmState === NtlmStateEnum.Authenticated);
    return auth;
  }

  matchHostOrNew(ntlmHostUrl: CompleteUrl): boolean {
    return (
      this._ntlmHost === undefined || this._ntlmHost.href === ntlmHostUrl.href
    );
  }

  getState(ntlmHostUrl: CompleteUrl): NtlmStateEnum {
    if (this._ntlmHost && ntlmHostUrl.href === this._ntlmHost.href) {
      return this._ntlmState;
    }
    return NtlmStateEnum.NotAuthenticated;
  }

  setState(ntlmHostUrl: CompleteUrl, authState: NtlmStateEnum) {
    this._ntlmHost = ntlmHostUrl;
    this._ntlmState = authState;
  }

  clearRequestBody() {
    this._requestBody = Buffer.alloc(0);
  }

  addToRequestBody(chunk: Buffer) {
    this._requestBody = Buffer.concat([this._requestBody, chunk]);
  }

  getRequestBody(): Buffer {
    return this._requestBody;
  }

  destroy() {
    if (this._agent.destroy) {
      this._agent.destroy(); // Destroys any sockets to servers
    }
    if (this._winSso) {
      this._winSso.freeAuthContext();
    }
  }
}
