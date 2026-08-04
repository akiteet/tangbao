'use strict';
/*
 * 模型调用统一错误（7 类）
 *   - 渲染进程：以 <script> 加载，挂到 window.App.ModelErrors
 *   - 主进程（模型网关 gateway.js）：以 require 加载
 *
 * 取代网关把上游原始 JSON 原样透传给前端的做法：先按 HTTP 状态 + 错误文案归类成
 * 受控的有限错误类型，前端据此给出更精准的提示，而不必去解析各家厂商格式各异的报错。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.App = window.App || {};
    window.App.ModelErrors = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  class ModelError extends Error {
    constructor(type, message, status) {
      super(message);
      this.name = 'ModelError';
      this.type = type;        // 受控错误类型（见下 7 类）
      this.status = status || 0;
    }
  }

  class AuthenticationError extends ModelError {
    constructor(m, s) { super('authentication', m || '认证失败：API Key 无效或已过期', s || 401); }
  }
  class RateLimitError extends ModelError {
    constructor(m, s) { super('rate_limit', m || '请求过于频繁，已被模型服务限流', s || 429); }
  }
  class ModelUnavailableError extends ModelError {
    constructor(m, s) { super('model_unavailable', m || '模型不可用或不存在', s || 404); }
  }
  class ContextOverflowError extends ModelError {
    constructor(m, s) { super('context_overflow', m || '超出模型上下文长度上限', s || 400); }
  }
  class UnsupportedCapabilityError extends ModelError {
    constructor(m, s) { super('unsupported_capability', m || '当前模型不支持该功能或参数', s || 400); }
  }
  class NetworkError extends ModelError {
    constructor(m, s) { super('network', m || '网络连接失败', s || 0); }
  }
  class ProviderResponseError extends ModelError {
    constructor(m, s) { super('provider_response', m || '模型服务返回异常', s || 502); }
  }

  // 按 HTTP 状态 + 错误文案归类成受控错误类型
  function classify(status, rawMessage) {
    const msg = rawMessage || '';
    const lc = msg.toLowerCase();
    if (status === 401 || status === 403) return new AuthenticationError(msg, status);
    if (status === 429) return new RateLimitError(msg, status);
    if (status === 404) return new ModelUnavailableError(msg, status);
    if (status === 400) {
      if (/context length|maximum context|too many tokens|token limit|上下文|超出/.test(lc))
        return new ContextOverflowError(msg, status);
      return new UnsupportedCapabilityError(msg, status);
    }
    if (status >= 500) return new ProviderResponseError(msg, status);
    return new ProviderResponseError(msg, status);
  }

  return {
    ModelError,
    AuthenticationError, RateLimitError, ModelUnavailableError,
    ContextOverflowError, UnsupportedCapabilityError, NetworkError, ProviderResponseError,
    classify,
  };
});
