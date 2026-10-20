import { SESSION_COOKIE, type Account, type MessageImpl, type ServerApi, type SessionInfo } from '@nexlibris/common';
import { SESSION_DAYS } from '../accounts';
import { own, type Caller, type Services } from './context';
import { clientAddress, cookieToken, isHttps, sameSite, sessionToken } from './request';

/**
 * The server API's accounts: who's signed in, signing in, up and out, and changing the password.
 * The server's own pages get a session cookie; the apps ask for the token instead
 * (`Credentials.token`), and send it as a bearer token.
 */
export function authEndpoints({ accounts, settings }: Services): MessageImpl<ServerApi, Caller>['auth'] {
  async function sessionInfo(account: Account | undefined): Promise<SessionInfo> {
    return { ...(account && { account }), signup: !account && (await accounts.canSignUp()), name: settings.name };
  }

  /** Starts or ends the caller's session: a cookie for the server's own pages, or for an app the token itself, in the reply. */
  function setSession(caller: Caller, token: string | undefined, forApp = false): Pick<SessionInfo, 'token'> {
    if (forApp) return token ? { token } : {};
    const secure = settings.secureCookies === 'auto' ? isHttps(caller.req, settings.trustProxy) : settings.secureCookies;
    const age = token ? SESSION_DAYS * 24 * 60 * 60 : 0;
    caller.res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`);
    return {};
  }

  return {
    session: (_, caller) => sessionInfo(caller.account),
    async signIn(request, caller) {
      const { name, password } = request ?? {};
      const forApp = request?.token === true;
      // Another site mustn't sign this browser in, to an account of its choosing.
      if (!forApp) sameSite(caller.req, settings.trustProxy);
      const { account, token } = await accounts.signIn(name, password, clientAddress(caller.req, settings.trustProxy));
      return { ...(await sessionInfo(account)), ...setSession(caller, token, forApp) };
    },
    async signUp(request, caller) {
      const { name, password } = request ?? {};
      const forApp = request?.token === true;
      if (!forApp) sameSite(caller.req, settings.trustProxy);
      const account = await accounts.create(name, password);
      return { ...(await sessionInfo(account)), ...setSession(caller, await accounts.startSession(account.id), forApp) };
    },
    async signOut(_, caller) {
      await accounts.endSession(sessionToken(caller.req));
      if (cookieToken(caller.req)) setSession(caller, undefined);
      return sessionInfo(undefined);
    },
    async changePassword(request, caller) {
      const current = typeof request?.password === 'string' ? request.password : '';
      await accounts.setPassword(own(caller).id, current, request?.newPassword, sessionToken(caller.req));
      return null;
    },
  };
}
