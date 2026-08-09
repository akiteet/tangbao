'use strict';

function safeParse(value) {
  if (value == null) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return {}; }
}

function detectAdapter(model, apiBase) {
  const base = String(apiBase || '');
  const name = String(model || '');
  if (/api\.anthropic\.com/i.test(base)) return 'anthropic';
  if (/generativelanguage\.googleapis\.com/i.test(base)) return 'gemini';
  if (/api\.openai\.com/i.test(base) && /^(?:gpt-5|o[134]|codex)/i.test(name)) return 'openai-responses';
  if (/^claude/i.test(name) && /anthropic/i.test(base)) return 'anthropic';
  if (/^gemini/i.test(name) && /googleapis/i.test(base)) return 'gemini';
  return 'openai';
}

function openAITools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description || '',
    parameters: tool.function.parameters || { type: 'object', properties: {} },
  }));
}

function responseInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: String(message.content == null ? '' : message.content) });
      continue;
    }
    const item = {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: String(message.content || '') }],
    };
    input.push(item);
    for (const call of message.tool_calls || []) {
      input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments || '{}' });
    }
  }
  return input;
}

function buildRequest(adapter, opts) {
  const options = opts || {};
  const base = String(options.apiBase || '').replace(/\/+$/, '');
  const model = String(options.model || '');
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const tools = Array.isArray(options.tools) ? options.tools : [];
  const stream = !!options.stream;
  const promptCaching = options.promptCaching !== false;
  const cachedContent = String(options.cachedContentName || options.cachedContent || '').trim();

  if (adapter === 'openai-responses') {
    const instructions = messages.filter((message) => message.role === 'system').map((message) => String(message.content || '')).join('\n\n');
    const body = { model, input: responseInput(messages), tools: openAITools(tools), stream };
    if (instructions) body.instructions = instructions;
    return {
      url: /\/v1$/i.test(base) ? base + '/responses' : base + '/v1/responses',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(options.apiKey || '') },
      body,
    };
  }

  if (adapter === 'anthropic') {
    const system = messages.filter((message) => message.role === 'system').map((message) => String(message.content || '')).join('\n\n');
    const converted = messages.filter((message) => message.role !== 'system').map((message) => {
      if (message.role === 'tool') {
        return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: String(message.content == null ? '' : message.content) }] };
      }
      if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length) {
        const blocks = [];
        if (message.content) blocks.push({ type: 'text', text: String(message.content) });
        for (const call of message.tool_calls) blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: safeParse(call.function.arguments) });
        return { role: 'assistant', content: blocks };
      }
      return { role: message.role, content: String(message.content == null ? '' : message.content) };
    });
    const body = { model, max_tokens: Number(options.maxOutputTokens) || 8192, messages: converted, stream };
    if (system) body.system = promptCaching ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system;
    if (tools.length) {
      body.tools = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description || '',
        input_schema: tool.function.parameters || { type: 'object', properties: {} },
        ...(promptCaching ? { cache_control: { type: 'ephemeral' } } : {}),
      }));
    }
    return {
      url: (/\/v1$/i.test(base) ? base : base + '/v1') + '/messages',
      headers: {
        'x-api-key': String(options.apiKey || ''),
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
      },
      body,
    };
  }

  if (adapter === 'gemini') {
    const system = messages.filter((message) => message.role === 'system').map((message) => String(message.content || '')).join('\n\n');
    const names = new Map();
    for (const message of messages) for (const call of message.tool_calls || []) names.set(call.id, call.function.name);
    const contents = messages.filter((message) => message.role !== 'system').map((message) => {
      if (message.role === 'tool') {
        return { role: 'user', parts: [{ functionResponse: { name: names.get(message.tool_call_id) || 'tool', response: { output: String(message.content == null ? '' : message.content) } } }] };
      }
      if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length) {
        const parts = [];
        if (message.content) parts.push({ text: String(message.content) });
        for (const call of message.tool_calls) parts.push({ functionCall: { name: call.function.name, args: safeParse(call.function.arguments) } });
        return { role: 'model', parts };
      }
      return { role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(message.content == null ? '' : message.content) }] };
    });
    const body = { contents };
    // Gemini cache hits are real only when a provider-created cachedContent
    // resource is supplied. Re-sending the same prompt is not a cache hit.
    if (cachedContent) body.cachedContent = cachedContent;
    if (system && !cachedContent) body.systemInstruction = { parts: [{ text: system }] };
    if (tools.length) {
      body.tools = [{ functionDeclarations: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description || '',
        parameters: tool.function.parameters || { type: 'object', properties: {} },
      })) }];
    }
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return {
      url: base + '/v1beta/models/' + encodeURIComponent(model) + ':' + action,
      headers: {
        'x-goog-api-key': String(options.apiKey || ''),
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
      },
      body,
    };
  }

  const url = /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
  const body = { model, messages, tools, stream, tool_choice: 'auto' };
  if (stream) body.stream_options = Object.assign({}, options.streamOptions || {}, { include_usage: true });
  return {
    url,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + String(options.apiKey || '') },
    body,
  };
}

function parseNonStream(adapter, json) {
  if (adapter === 'openai-responses') {
    let content = '';
    let reasoning = '';
    const toolCalls = [];
    for (const item of json && json.output || []) {
      if (item.type === 'message') {
        for (const part of item.content || []) {
          if (part.type === 'output_text') content += part.text || '';
          if (part.type === 'reasoning_text' || part.type === 'summary_text') reasoning += part.text || '';
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({ id: item.call_id || item.id || ('call_' + toolCalls.length), name: item.name || '', arguments: item.arguments || '{}' });
      } else if (item.type === 'reasoning') {
        for (const part of item.summary || []) reasoning += part.text || '';
      }
    }
    return { content, reasoning, toolCalls };
  }
  if (adapter === 'anthropic') {
    let content = '';
    let reasoning = '';
    const toolCalls = [];
    for (const block of json && json.content || []) {
      if (block.type === 'text') content += block.text || '';
      else if (block.type === 'thinking') reasoning += block.thinking || '';
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id || ('call_' + toolCalls.length), name: block.name || '', arguments: JSON.stringify(block.input || {}) });
    }
    return { content, reasoning, toolCalls };
  }
  if (adapter === 'gemini') {
    let content = '';
    let reasoning = '';
    const toolCalls = [];
    const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts || [];
    for (const part of parts) {
      if (part.text) {
        if (part.thought) reasoning += part.text;
        else content += part.text;
      } else if (part.functionCall) {
        toolCalls.push({ id: part.functionCall.id || ('call_' + toolCalls.length), name: part.functionCall.name || '', arguments: JSON.stringify(part.functionCall.args || {}) });
      }
    }
    return { content, reasoning, toolCalls };
  }
  const message = json && json.choices && json.choices[0] && json.choices[0].message;
  return {
    content: message && message.content || '',
    reasoning: message && message.reasoning_content || '',
    toolCalls: (message && message.tool_calls || []).map((call, index) => ({ id: call.id || ('call_' + index), name: call.function && call.function.name || '', arguments: call.function && call.function.arguments || '' })),
  };
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeUsage(adapter, json) {
  const out = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let cacheReported = false;
  if (adapter === 'anthropic') {
    const usage = json && json.usage || {};
    const cacheCreation = usage.cache_creation || {};
    const cacheWrite = usage.cache_creation_input_tokens != null
      ? usage.cache_creation_input_tokens
      : numberOrZero(cacheCreation.ephemeral_5m_input_tokens) + numberOrZero(cacheCreation.ephemeral_1h_input_tokens);
    out.inputTokens = numberOrZero(usage.input_tokens);
    out.outputTokens = numberOrZero(usage.output_tokens);
    cacheReported = usage.cache_read_input_tokens != null || usage.cache_creation_input_tokens != null || Object.keys(cacheCreation).length > 0;
    out.cacheReadTokens = numberOrZero(usage.cache_read_input_tokens);
    out.cacheWriteTokens = numberOrZero(cacheWrite);
  } else if (adapter === 'gemini') {
    const usage = json && json.usageMetadata || {};
    out.inputTokens = numberOrZero(usage.promptTokenCount);
    out.outputTokens = numberOrZero(usage.candidatesTokenCount);
    out.reasoningTokens = numberOrZero(usage.thoughtsTokenCount);
    cacheReported = usage.cachedContentTokenCount != null;
    out.cacheReadTokens = numberOrZero(usage.cachedContentTokenCount);
  } else if (adapter === 'openai-responses') {
    const usage = json && json.usage || {};
    out.inputTokens = numberOrZero(usage.input_tokens);
    out.outputTokens = numberOrZero(usage.output_tokens);
    out.reasoningTokens = numberOrZero(usage.output_tokens_details && usage.output_tokens_details.reasoning_tokens);
    cacheReported = !!(usage.input_tokens_details && usage.input_tokens_details.cached_tokens != null);
    out.cacheReadTokens = numberOrZero(usage.input_tokens_details && usage.input_tokens_details.cached_tokens);
  } else {
    const usage = json && json.usage || {};
    const details = usage.prompt_tokens_details || {};
    out.inputTokens = numberOrZero(usage.prompt_tokens);
    out.outputTokens = numberOrZero(usage.completion_tokens);
    out.reasoningTokens = numberOrZero(usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens);
    cacheReported = details.cached_tokens != null || details.cache_read_input_tokens != null;
    out.cacheReadTokens = numberOrZero(details.cached_tokens != null ? details.cached_tokens : details.cache_read_input_tokens);
    out.cacheWriteTokens = numberOrZero(details.cache_write_tokens);
  }
  Object.defineProperty(out, 'cacheReported', { value: cacheReported, enumerable: false, configurable: true });
  return out;
}

function mergeUsage(previous, incoming) {
  if (!previous) return incoming || null;
  if (!incoming) return previous;
  const merged = Object.assign({}, previous, incoming);
  for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (incoming[key] === 0 && previous[key] > 0) merged[key] = previous[key];
  }
  const cacheReported = previous.cacheReported === true || incoming.cacheReported === true;
  Object.defineProperty(merged, 'cacheReported', { value: cacheReported, enumerable: false, configurable: true });
  return merged;
}

function parseSSE(adapter, line, state) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith(':') || raw === 'data: [DONE]') return null;
  let data = raw;
  if (data.startsWith('data:')) data = data.slice(5).trim();
  if (data.startsWith('event:')) return null;
  let json;
  try { json = JSON.parse(data); } catch (_) { return null; }
  const current = state || {};

  if (adapter === 'openai-responses') {
    const type = json.type || '';
    if (type === 'response.output_text.delta') return { content: json.delta || '' };
    if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') return { reasoning: json.delta || '' };
    if (type === 'response.output_item.added' && json.item && json.item.type === 'function_call') {
      current.calls = current.calls || {};
      current.calls[json.output_index] = { id: json.item.call_id || json.item.id, name: json.item.name || '', arguments: '' };
      return null;
    }
    if (type === 'response.function_call_arguments.delta') {
      current.calls = current.calls || {};
      const call = current.calls[json.output_index] || (current.calls[json.output_index] = { id: 'call_' + json.output_index, name: '', arguments: '' });
      call.arguments += json.delta || '';
      return null;
    }
    if (type === 'response.output_item.done' && json.item && json.item.type === 'function_call') {
      return { toolCall: { id: json.item.call_id || json.item.id, name: json.item.name || '', arguments: json.item.arguments || ((current.calls && current.calls[json.output_index] && current.calls[json.output_index].arguments) || '{}') } };
    }
    if (type === 'response.completed') return { usage: normalizeUsage(adapter, json.response || json), done: true };
  }

  if (adapter === 'anthropic') {
    if (json.type === 'content_block_start' && json.content_block && json.content_block.type === 'tool_use') {
      current.calls = current.calls || {};
      current.calls[json.index] = { id: json.content_block.id, name: json.content_block.name, arguments: '' };
      return null;
    }
    if (json.type === 'content_block_delta') {
      const delta = json.delta || {};
      if (delta.type === 'text_delta') return { content: delta.text || '' };
      if (delta.type === 'thinking_delta') return { reasoning: delta.thinking || '' };
      if (delta.type === 'input_json_delta') {
        current.calls = current.calls || {};
        const call = current.calls[json.index] || (current.calls[json.index] = { id: 'call_' + json.index, name: '', arguments: '' });
        call.arguments += delta.partial_json || '';
        return null;
      }
    }
    if (json.type === 'content_block_stop' && current.calls && current.calls[json.index]) return { toolCall: current.calls[json.index] };
    if (json.type === 'message_start' || json.type === 'message_delta') return { usage: normalizeUsage(adapter, json.message || json), done: json.type === 'message_delta' && json.delta && json.delta.stop_reason != null };
  }

  if (adapter === 'gemini') {
    const parsed = parseNonStream(adapter, json);
    return { content: parsed.content, reasoning: parsed.reasoning, toolCalls: parsed.toolCalls, usage: normalizeUsage(adapter, json), done: !!(json.candidates && json.candidates[0] && json.candidates[0].finishReason) };
  }

  if (adapter === 'openai') {
    const choice = json.choices && json.choices[0] || {};
    const delta = choice.delta || {};
    return { content: delta.content || '', reasoning: delta.reasoning_content || '', toolCalls: delta.tool_calls || [], usage: normalizeUsage(adapter, json), done: choice.finish_reason != null };
  }
  return null;
}

module.exports = { detectAdapter, buildRequest, parseNonStream, normalizeUsage, mergeUsage, parseSSE };
