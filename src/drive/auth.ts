import type { TokenProvider } from './types';
import { DriveApiError } from './errors';

function runtimeError(): Error | undefined {
  const message = chrome.runtime.lastError?.message;
  return message ? new Error(message) : undefined;
}

export class ChromeIdentityTokenProvider implements TokenProvider {
  async getAccessToken(interactive = false): Promise<string> {
    return new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive }, (result) => {
        const error = runtimeError();
        if (error) {
          reject(new DriveApiError(error.message, 401, { retryable: false }));
          return;
        }
        const token = typeof result === 'string' ? result : result?.token;
        if (!token) {
          reject(
            new DriveApiError(
              'Google OAuth returned no token. Configure WXT_GOOGLE_CLIENT_ID and reload the extension.',
              401,
              { retryable: false },
            ),
          );
          return;
        }
        resolve(token);
      });
    });
  }

  async invalidateAccessToken(token: string): Promise<void> {
    await new Promise<void>((resolve) => {
      chrome.identity.removeCachedAuthToken({ token }, () => resolve());
    });
  }

  async disconnect(): Promise<void> {
    try {
      const token = await this.getAccessToken(false);
      await this.invalidateAccessToken(token);
      await fetch(
        `https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(token)}`,
        { method: 'POST' },
      );
    } catch {
      // Disconnect remains idempotent when there is no cached token.
    }
  }
}
