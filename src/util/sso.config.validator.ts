import os from 'os';

import { NtlmSsoConfig } from '../models/ntlm.sso.config.model';
import { NtlmConfigValidateResult } from '../models/ntlm.config.validate.result';
import { osSupported } from 'win-sso';

export class SsoConfigValidator {
  static validate(config: NtlmSsoConfig): NtlmConfigValidateResult {
    let result = { ok: false } as NtlmConfigValidateResult;

    if (!osSupported() && (os.platform() as string != 'browser')) {
      result.message = 'SSO is not supported on this platform. Only Windows OSs are supported.';
      return result;
    }

    if (!config.ntlmHosts) {
      result.message = 'Incomplete configuration. ntlmHosts is an required field.';
      return result;
    }

    if (!(config.ntlmHosts instanceof Array)) {
      result.message = 'Invalid ntlmHosts, must be an array.';
      return result;
    }

    let allValid = true;
    config.ntlmHosts.forEach((ntlmHost) => {
      if (!this.validHostnameOrFqdn(ntlmHost)) {
        result.message = 'Invalid host [' + this.escapeHtml(ntlmHost) + '] in ntlmHosts, must be only a hostname or FQDN ' +
          '(localhost or www.google.com is ok, https://www.google.com:443/search is not ok). Wildcards are accepted.';
        allValid = false;
        return result;
      }
    });

    result.ok = allValid;
    return result;
  }

  private static validHostnameOrFqdn(host: string): boolean {
    if (host.indexOf('\n') !== -1) {
      return false;
    }
    // Replace all wildcards with a character to pass hostname/FQDN test
    const hostNoWildcard = host.replace(/\*/g, 'a');
    const validatorRegex = new RegExp(/^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9\-]*[A-Za-z0-9])$/);
    return validatorRegex.test(hostNoWildcard);
  }

  private static escapeHtml(unsafe: string) {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
  }
}

