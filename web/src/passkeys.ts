import * as api from "./api";

type JsonDescriptor = Omit<PublicKeyCredentialDescriptor, "id"> & { id: string };
export type RegistrationOptions = Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials"> & {
  challenge: string; user: Omit<PublicKeyCredentialUserEntity, "id"> & { id: string }; excludeCredentials?: JsonDescriptor[];
};
export type AuthenticationOptions = Omit<PublicKeyCredentialRequestOptions, "challenge" | "allowCredentials"> & {
  challenge: string; allowCredentials?: JsonDescriptor[];
};
export type PasskeyChallenge<T> = { request_id: string; options: T };

export function passkeyUnavailable(capability: api.PasskeyCapability): string | null {
  if (!window.isSecureContext) return "通行密钥需要 HTTPS；本地开发请使用 localhost。";
  if (typeof PublicKeyCredential === "undefined" || !navigator.credentials?.create || !navigator.credentials?.get) return "当前浏览器不支持通行密钥，请使用登录密码。";
  if (!capability.available) return capability.reason || "本站暂时无法使用通行密钥。";
  if (capability.origin !== window.location.origin) return "当前地址与已配置的站点地址不同，请从本站公开访问地址使用通行密钥。";
  return null;
}

function decode(value: string): ArrayBuffer {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  const buffer = new ArrayBuffer(raw.length), bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return buffer;
}

function encode(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let raw = "";
  for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function deviceError(reason: unknown): Error {
  if (reason instanceof DOMException) {
    if (reason.name === "AbortError") return new Error("设备验证已取消");
    if (reason.name === "NotAllowedError") return new Error("已取消或未完成设备验证，请重试，也可以使用登录密码");
    if (reason.name === "InvalidStateError") return new Error("这个设备已有相同凭据，请使用已绑定的通行密钥");
    if (reason.name === "SecurityError") return new Error("站点地址不符合通行密钥要求，请使用已配置的 HTTPS 地址");
    if (reason.name === "NotSupportedError") return new Error("设备无法创建此通行密钥，请设置设备锁屏或使用其他浏览器");
  }
  return new Error("设备验证未完成，请重试或使用登录密码");
}

async function create(options: RegistrationOptions, signal: AbortSignal) {
  try {
    const result = await navigator.credentials.create({ signal, publicKey: {
      ...options, challenge: decode(options.challenge), user: { ...options.user, id: decode(options.user.id) },
      excludeCredentials: options.excludeCredentials?.map(item => ({ ...item, id: decode(item.id) })),
    } });
    if (!(result instanceof PublicKeyCredential) || !(result.response instanceof AuthenticatorAttestationResponse)) throw new Error("无法创建通行密钥");
    return { id: result.id, rawId: encode(result.rawId), type: result.type,
      clientExtensionResults: result.getClientExtensionResults(),
      response: { clientDataJSON: encode(result.response.clientDataJSON), attestationObject: encode(result.response.attestationObject),
        transports: result.response.getTransports?.() || [] } };
  } catch (reason) { throw deviceError(reason); }
}

async function authenticate(options: AuthenticationOptions, signal: AbortSignal) {
  try {
    const result = await navigator.credentials.get({ signal, publicKey: {
      ...options, challenge: decode(options.challenge),
      allowCredentials: options.allowCredentials?.map(item => ({ ...item, id: decode(item.id) })),
    } });
    if (!(result instanceof PublicKeyCredential) || !(result.response instanceof AuthenticatorAssertionResponse)) throw new Error("无法读取通行密钥");
    return { id: result.id, rawId: encode(result.rawId), type: result.type,
      clientExtensionResults: result.getClientExtensionResults(),
      response: { clientDataJSON: encode(result.response.clientDataJSON), authenticatorData: encode(result.response.authenticatorData),
        signature: encode(result.response.signature), userHandle: result.response.userHandle ? encode(result.response.userHandle) : null } };
  } catch (reason) { throw deviceError(reason); }
}

export type PasskeyRegistrationStage = "device" | "saving";

export async function registerPasskey(password: string, name: string, signal: AbortSignal, onStage?: (stage: PasskeyRegistrationStage) => void) {
  const challenge = await api.beginPasskeyRegistration(password, name, signal);
  if (signal.aborted) throw new DOMException("设备验证已取消", "AbortError");
  onStage?.("device");
  const credential = await create(challenge.options, signal);
  if (signal.aborted) throw new DOMException("设备验证已取消", "AbortError");
  onStage?.("saving");
  return api.finishPasskeyRegistration(challenge.request_id, credential, signal);
}

export async function unlockWithPrivatePasskey(signal: AbortSignal) {
  const challenge = await api.beginPrivatePasskeyUnlock(signal);
  const credential = await authenticate(challenge.options, signal);
  return api.finishPrivatePasskeyUnlock(challenge.request_id, credential, signal);
}

/** 私密对话里把文件移出私密空间前的重新验证（§24.5.3）：只取得通行密钥断言，随确认请求一起提交，不签发新的私密授权。 */
export async function privatePasskeyAssertion(signal: AbortSignal) {
  const challenge = await api.beginPrivatePasskeyUnlock(signal);
  return { request_id: challenge.request_id, credential: await authenticate(challenge.options, signal) };
}

export async function loginWithPasskey(remember: boolean, signal: AbortSignal) {
  const challenge = await api.beginPasskeyLogin(remember, signal);
  const credential = await authenticate(challenge.options, signal);
  return api.finishPasskeyLogin(challenge.request_id, credential, signal);
}
