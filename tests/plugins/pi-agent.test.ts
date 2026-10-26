/**
 * ABOUTME: Tests for the PiAgentPlugin.
 * Tests metadata, initialization, setup questions, and protected methods.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PiAgentPlugin, parsePiJsonLine } from '../../src/plugins/agents/builtin/pi.js';
import { __test__ as baseAgentTestHelpers } from '../../src/plugins/agents/base.js';
import type {
  AgentFileContext,
  AgentExecuteOptions,
} from '../../src/plugins/agents/types.js';

/**
 * Test subclass to expose protected methods for testing.
 */
class TestablePiPlugin extends PiAgentPlugin {
  /** Expose buildArgs for testing */
  testBuildArgs(
    prompt: string,
    files?: AgentFileContext[],
    options?: AgentExecuteOptions
  ): string[] {
    return this['buildArgs'](prompt, files, options);
  }

  /** Expose getStdinInput for testing */
  testGetStdinInput(
    prompt: string,
    files?: AgentFileContext[],
    options?: AgentExecuteOptions
  ): string {
    return this['getStdinInput'](prompt, files, options);
  }
}

/**
 * Safely dispose a plugin if it's still ready.
 * Only catches errors from an already-disposed plugin (isReady returned a
 * stale value); genuine disposal failures are re-thrown so tests surface them.
 */
async function disposeIfReady(plugin: PiAgentPlugin): Promise<void> {
  if (await plugin.isReady()) {
    await plugin.dispose();
  }
}

describe('PiAgentPlugin', () => {
  let plugin: PiAgentPlugin;

  beforeEach(() => {
    plugin = new PiAgentPlugin();
  });

  afterEach(async () => {
    await disposeIfReady(plugin);
  });

  describe('metadata', () => {
    test('has correct plugin ID', () => {
      expect(plugin.meta.id).toBe('pi');
    });

    test('has correct default command', () => {
      expect(plugin.meta.defaultCommand).toBe('pi');
    });

    test('supports streaming', () => {
      expect(plugin.meta.supportsStreaming).toBe(true);
    });

    test('supports interruption', () => {
      expect(plugin.meta.supportsInterrupt).toBe(true);
    });

    test('supports file context', () => {
      expect(plugin.meta.supportsFileContext).toBe(true);
    });

    test('supports subagent tracing', () => {
      expect(plugin.meta.supportsSubagentTracing).toBe(true);
    });

    test('has jsonl structured output format', () => {
      expect(plugin.meta.structuredOutputFormat).toBe('jsonl');
    });

    test('has correct skillsPaths', () => {
      expect(plugin.meta.skillsPaths).toBeDefined();
      expect(plugin.meta.skillsPaths?.personal).toBe('~/.pi/skills');
      expect(plugin.meta.skillsPaths?.repo).toBe('.pi/skills');
    });
  });

  describe('initialization', () => {
    test('initializes with default config', async () => {
      await plugin.initialize({});
      expect(await plugin.isReady()).toBe(true);
    });

    test('accepts mode config', async () => {
      await plugin.initialize({ mode: 'text' });
      expect(await plugin.isReady()).toBe(true);
    });

    test('accepts model config', async () => {
      await plugin.initialize({ model: 'sonnet' });
      expect(await plugin.isReady()).toBe(true);
    });

    test('accepts thinking config', async () => {
      await plugin.initialize({ thinking: 'high' });
      expect(await plugin.isReady()).toBe(true);
    });

    test('accepts timeout config', async () => {
      await plugin.initialize({ timeout: 60000 });
      expect(await plugin.isReady()).toBe(true);
    });

    test('ignores invalid mode and preserves default json mode', async () => {
      const testable = new TestablePiPlugin();
      await testable.initialize({ mode: 'invalid' });
      expect(await testable.isReady()).toBe(true);
      // Default mode is json, so --mode json should appear
      const args = testable.testBuildArgs('test');
      expect(args).toContain('--mode');
      expect(args).toContain('json');
      await disposeIfReady(testable);
    });

    test('ignores invalid thinking level and omits --thinking', async () => {
      const testable = new TestablePiPlugin();
      await testable.initialize({ thinking: 'ultra' });
      expect(await testable.isReady()).toBe(true);
      const args = testable.testBuildArgs('test');
      expect(args).not.toContain('--thinking');
      await disposeIfReady(testable);
    });

    test('ignores non-string model and omits --model', async () => {
      const testable = new TestablePiPlugin();
      await testable.initialize({ model: 123 });
      expect(await testable.isReady()).toBe(true);
      const args = testable.testBuildArgs('test');
      expect(args).not.toContain('--model');
      await disposeIfReady(testable);
    });

    test('ignores empty model string and omits --model', async () => {
      const testable = new TestablePiPlugin();
      await testable.initialize({ model: '' });
      expect(await testable.isReady()).toBe(true);
      const args = testable.testBuildArgs('test');
      expect(args).not.toContain('--model');
      await disposeIfReady(testable);
    });

    test('ignores non-number timeout', async () => {
      await plugin.initialize({ timeout: '60000' });
      expect(await plugin.isReady()).toBe(true);
    });

    test('ignores zero timeout', async () => {
      await plugin.initialize({ timeout: 0 });
      expect(await plugin.isReady()).toBe(true);
    });
  });

  describe('extractCompletionText', () => {
    const marker = '<promise>COMPLETE</promise>';
    const jsonl = (...events: unknown[]): string => events.map(event => JSON.stringify(event)).join('\n');
    const assistantEnd = (text: string, stopReason = 'stop') => ({
      type: 'message_end',
      message: { role: 'assistant', stopReason, content: [{ type: 'text', text }] },
    });

    test('should return final text blocks when the last assistant response succeeds', () => {
      const stdout = jsonl(
        { type: 'agent_start' },
        { type: 'message_start', message: { role: 'user', content: marker } },
        { type: 'message_end', message: { role: 'user', content: marker } },
        assistantEnd('Intermediate', 'toolUse'),
        { type: 'message_end', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: marker }], isError: false } },
        { type: 'message_start', message: { role: 'assistant', content: [] } },
        { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'text', text: 'Done.\n' },
          { type: 'text', text: marker },
        ] } },
        { type: 'agent_end', messages: [] },
      );

      const result = plugin.extractCompletionText(stdout);

      expect(result, 'Only final successful assistant text blocks should be returned').toBe(`Done.\n${marker}`);
    });

    test('should replace earlier text when another successful assistant response ends', () => {
      const stdout = jsonl(assistantEnd(marker), assistantEnd('Still blocked'));

      const result = plugin.extractCompletionText(stdout);

      expect(result, 'Earlier assistant responses must not be concatenated').toBe('Still blocked');
    });

    test.each(['toolUse', 'error', 'aborted', 'length', undefined])(
      'should clear earlier completion when the latest assistant stop reason is %s', (stopReason) => {
        const stdout = jsonl(assistantEnd(marker), {
          type: 'message_end',
          message: { role: 'assistant', stopReason, content: [{ type: 'text', text: marker }] },
        });

        const result = plugin.extractCompletionText(stdout);

        expect(result, 'Only stopReason stop may authorize completion').toBe('');
      },
    );

    test.each(['assistant', 'toolResult', 'user'])(
      'should clear earlier completion when a later %s message remains unfinished', (role) => {
        const stdout = jsonl(assistantEnd(marker),
          { type: 'message_start', message: { role, content: [] } },
          { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: marker } },
        );

        const result = plugin.extractCompletionText(stdout);

        expect(result, 'An unfinished later message must invalidate earlier completion').toBe('');
      },
    );

    test.each([
      { role: 'user', content: marker },
      { role: 'user', content: [{ type: 'text', text: marker }] },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: marker }], isError: false },
      { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: marker, isError: false },
      { content: [{ type: 'text', text: marker }], stopReason: 'stop' },
    ])('should clear earlier completion when a non-assistant message ends with %j', (message) => {
      const stdout = jsonl(assistantEnd(marker), { type: 'message_end', message });

      const result = plugin.extractCompletionText(stdout);

      expect(result, 'User and tool output must never authorize completion').toBe('');
    });

    test('should exclude hidden markers when only thinking and tool blocks contain them', () => {
      const stdout = jsonl({ type: 'message_end', message: {
        role: 'assistant', stopReason: 'stop', content: [
          { type: 'thinking', thinking: marker },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: `echo ${marker}` } },
          { type: 'text', text: 'Blocked' },
        ],
      } });

      const result = plugin.extractCompletionText(stdout);

      expect(result, 'Thinking and tool-call payloads must not enter completion text').toBe('Blocked');
    });

    test('should clear completion when the agent settles as aborted', () => {
      const stdout = jsonl(assistantEnd(marker), { type: 'agent_settled', aborted: true });

      const result = plugin.extractCompletionText(stdout);

      expect(result, 'Aborted settlement must invalidate successful-looking output').toBe('');
    });

    test.each([
      '', marker, '{broken', 'null', '[]', '42',
      JSON.stringify({ type: 'unknown', text: marker }),
      JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: marker } }),
      JSON.stringify({ type: 'message_end' }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: marker } }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [null, [], { type: 'text', text: 42 }] } }),
    ])('should fail closed when JSON mode receives invalid or non-final output %j', (stdout) => {
      const result = plugin.extractCompletionText(stdout);

      expect(result, 'JSON mode must never fall back to raw stdout').toBe('');
    });

    test('should fail closed when malformed JSON follows a successful response', () => {
      const stdout = `${jsonl(assistantEnd(marker))}\n{"type":"message_start"`;

      const result = plugin.extractCompletionText(stdout);

      expect(result, 'A truncated later event must not preserve an earlier marker').toBe('');
    });

    test('should preserve final completion when the stdout limit cuts an earlier JSON record', () => {
      const stdout = jsonl(
        { type: 'message_end', message: { role: 'user', content: 'x'.repeat(1000) } },
        assistantEnd(marker),
      );
      const truncated = baseAgentTestHelpers.appendWithCharLimit('', stdout, 256);

      const result = plugin.extractCompletionText(truncated);

      expect(result, 'An intact final response must survive bounded stdout truncation').toBe(marker);
    });

    test('should preserve final completion when the stdout limit cuts exactly at a record boundary', () => {
      const finalResponse = jsonl(assistantEnd(marker));
      const prefixLength = '[...agent output truncated in memory...]\n'.length;
      const stdout = `${'x'.repeat(1000)}\n${finalResponse}`;
      const truncated = baseAgentTestHelpers.appendWithCharLimit('', stdout, prefixLength + finalResponse.length);

      const result = plugin.extractCompletionText(truncated);

      expect(result, 'A complete first retained record must not be discarded').toBe(marker);
    });

    test('should reject completion when a later JSON record is malformed after stdout truncation', () => {
      const stdout = `${jsonl(
        { type: 'message_end', message: { role: 'user', content: 'x'.repeat(1000) } },
        assistantEnd(marker),
      )}\n{"type":"message_start"`;
      const truncated = baseAgentTestHelpers.appendWithCharLimit('', stdout, 256);

      const result = plugin.extractCompletionText(truncated);

      expect(result, 'Only the truncated leading fragment may be ignored').toBe('');
    });

    test('should preserve plain output when text mode has no structured events', async () => {
      await plugin.initialize({ mode: 'text' });
      const stdout = `Done.\n${marker}\n`;

      const result = plugin.extractCompletionText(stdout);

      expect(result, 'Explicit text mode should preserve plain stdout unchanged').toBe(stdout);
    });

    test('should filter structured output when tracing forces JSON in text mode', async () => {
      await plugin.initialize({ mode: 'text' });
      const stdout = jsonl(
        { type: 'message_end', message: { role: 'user', content: marker } },
        assistantEnd('Blocked'),
      );

      const result = plugin.extractCompletionText(stdout);

      expect(result, 'Structured events must use final assistant extraction even in text mode').toBe('Blocked');
    });

    test('should fail closed when text mode receives structured output without a final response', async () => {
      await plugin.initialize({ mode: 'text' });
      const stdout = jsonl({ type: 'agent_start' },
        { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: marker } });

      const result = plugin.extractCompletionText(stdout);

      expect(result, 'Recognized JSON streams must never use raw text fallback').toBe('');
    });
  });

  describe('validateModel', () => {
    test('accepts any model (flexible format)', () => {
      // Pi accepts any model pattern
      expect(plugin.validateModel('')).toBeNull();
      expect(plugin.validateModel('sonnet')).toBeNull();
      expect(plugin.validateModel('haiku')).toBeNull();
      expect(plugin.validateModel('opus')).toBeNull();
      expect(plugin.validateModel('openai/gpt-4o')).toBeNull();
      expect(plugin.validateModel('anthropic/claude-sonnet')).toBeNull();
      expect(plugin.validateModel('sonnet:high')).toBeNull();
      expect(plugin.validateModel('gemini-2.5-pro')).toBeNull();
    });
  });

  describe('validateSetup', () => {
    test('always returns null (no validation)', async () => {
      const result = await plugin.validateSetup({});
      expect(result).toBeNull();
    });

    test('returns null with any answers', async () => {
      const result = await plugin.validateSetup({
        mode: 'json',
        model: 'sonnet',
        thinking: 'high',
      });
      expect(result).toBeNull();
    });
  });

  describe('setup questions', () => {
    test('includes mode question with choices', () => {
      const questions = plugin.getSetupQuestions();
      const modeQuestion = questions.find(q => q.id === 'mode');
      expect(modeQuestion).toBeDefined();
      expect(modeQuestion?.type).toBe('select');
      expect(modeQuestion?.choices).toBeDefined();
      expect(modeQuestion?.choices?.length).toBe(2);
      expect(modeQuestion?.default).toBe('json');
    });

    test('includes model question', () => {
      const questions = plugin.getSetupQuestions();
      const modelQuestion = questions.find(q => q.id === 'model');
      expect(modelQuestion).toBeDefined();
      expect(modelQuestion?.type).toBe('text');
      expect(modelQuestion?.default).toBe('');
    });

    test('includes thinking question with choices', () => {
      const questions = plugin.getSetupQuestions();
      const thinkingQuestion = questions.find(q => q.id === 'thinking');
      expect(thinkingQuestion).toBeDefined();
      expect(thinkingQuestion?.type).toBe('select');
      expect(thinkingQuestion?.choices).toBeDefined();
      expect(thinkingQuestion?.choices?.length).toBe(7); // Default + 6 levels
    });

    test('mode has helpful description', () => {
      const questions = plugin.getSetupQuestions();
      const modeQuestion = questions.find(q => q.id === 'mode');
      expect(modeQuestion?.help).toBeDefined();
      expect(modeQuestion?.help?.length).toBeGreaterThan(0);
    });

    test('model has helpful description', () => {
      const questions = plugin.getSetupQuestions();
      const modelQuestion = questions.find(q => q.id === 'model');
      expect(modelQuestion?.help).toBeDefined();
      expect(modelQuestion?.help?.length).toBeGreaterThan(0);
    });
  });

  describe('buildArgs', () => {
    let testablePlugin: TestablePiPlugin;

    beforeEach(async () => {
      testablePlugin = new TestablePiPlugin();
      await testablePlugin.initialize({});
    });

    afterEach(async () => {
      await disposeIfReady(testablePlugin);
    });

    test('includes --print for non-interactive mode', () => {
      const args = testablePlugin.testBuildArgs('test prompt');
      expect(args).toContain('--print');
    });

    test('includes --mode json by default for subagent tracing', () => {
      const args = testablePlugin.testBuildArgs('test prompt', undefined, { subagentTracing: true });
      expect(args).toContain('--mode');
      expect(args).toContain('json');
    });

    test('includes --mode json when mode is json', async () => {
      await testablePlugin.dispose();
      testablePlugin = new TestablePiPlugin();
      await testablePlugin.initialize({ mode: 'json' });

      const args = testablePlugin.testBuildArgs('test prompt');
      expect(args).toContain('--mode');
      expect(args).toContain('json');
    });

    test('does NOT include --mode json when mode is text', async () => {
      await testablePlugin.dispose();
      testablePlugin = new TestablePiPlugin();
      await testablePlugin.initialize({ mode: 'text' });

      const args = testablePlugin.testBuildArgs('test prompt');
      expect(args).not.toContain('--mode');
      expect(args).not.toContain('json');
    });

    test('does NOT include prompt in args (passed via stdin)', () => {
      const prompt = 'Hello world';
      const args = testablePlugin.testBuildArgs(prompt);

      // The prompt should NOT be in args - it's passed via stdin
      expect(args).not.toContain(prompt);
    });

    test('includes --model when model is configured', async () => {
      await testablePlugin.dispose();
      testablePlugin = new TestablePiPlugin();
      await testablePlugin.initialize({ model: 'sonnet' });

      const args = testablePlugin.testBuildArgs('test prompt');
      expect(args).toContain('--model');
      expect(args).toContain('sonnet');
    });

    test('excludes --model when not configured', () => {
      const args = testablePlugin.testBuildArgs('test prompt');
      expect(args).not.toContain('--model');
    });

    test('includes --thinking when thinking is configured', async () => {
      await testablePlugin.dispose();
      testablePlugin = new TestablePiPlugin();
      await testablePlugin.initialize({ thinking: 'high' });

      const args = testablePlugin.testBuildArgs('test prompt');
      expect(args).toContain('--thinking');
      expect(args).toContain('high');
    });

    test('excludes --thinking when not configured', () => {
      const args = testablePlugin.testBuildArgs('test prompt');
      expect(args).not.toContain('--thinking');
    });

    test('includes file context with @ prefix', () => {
      const files: AgentFileContext[] = [
        { path: '/path/to/file.ts' },
        { path: '/path/to/another.ts' },
      ];
      const args = testablePlugin.testBuildArgs('test prompt', files);

      expect(args).toContain('@/path/to/file.ts');
      expect(args).toContain('@/path/to/another.ts');
    });

    test('excludes file context when not provided', () => {
      const args = testablePlugin.testBuildArgs('test prompt');
      expect(args.some(arg => arg.startsWith('@'))).toBe(false);
    });

    test('has args in correct order', () => {
      const args = testablePlugin.testBuildArgs('test prompt');
      expect(args[0]).toBe('--print');
    });
  });

  describe('getStdinInput', () => {
    let testablePlugin: TestablePiPlugin;

    beforeEach(async () => {
      testablePlugin = new TestablePiPlugin();
      await testablePlugin.initialize({});
    });

    afterEach(async () => {
      await disposeIfReady(testablePlugin);
    });

    test('returns the prompt for stdin', () => {
      const prompt = 'Hello world';
      const stdinInput = testablePlugin.testGetStdinInput(prompt);

      expect(stdinInput).toBe(prompt);
    });

    test('returns prompt with special characters unchanged', () => {
      const prompt = 'feature with & special | characters > test "quoted"';
      const stdinInput = testablePlugin.testGetStdinInput(prompt);

      expect(stdinInput).toBe(prompt);
    });

    test('returns prompt with newlines', () => {
      const prompt = 'Line 1\nLine 2\nLine 3';
      const stdinInput = testablePlugin.testGetStdinInput(prompt);

      expect(stdinInput).toBe(prompt);
    });

    test('returns prompt with unicode characters', () => {
      const prompt = 'Hello 世界 🌍 émojis';
      const stdinInput = testablePlugin.testGetStdinInput(prompt);

      expect(stdinInput).toBe(prompt);
    });
  });

  describe('getSandboxRequirements', () => {
    test('returns expected auth paths', () => {
      const requirements = plugin.getSandboxRequirements();
      expect(requirements.authPaths).toContain('~/.pi');
    });

    test('returns requiresNetwork true', () => {
      const requirements = plugin.getSandboxRequirements();
      expect(requirements.requiresNetwork).toBe(true);
    });
  });
});

describe('parsePiJsonLine', () => {
  test('returns empty array for empty input', () => {
    expect(parsePiJsonLine('')).toEqual([]);
    expect(parsePiJsonLine(null as unknown as string)).toEqual([]);
    expect(parsePiJsonLine(undefined as unknown as string)).toEqual([]);
  });

  test('returns empty array for invalid JSON', () => {
    expect(parsePiJsonLine('not json')).toEqual([]);
    expect(parsePiJsonLine('{broken')).toEqual([]);
  });

  test('returns empty array for unknown event type', () => {
    const line = JSON.stringify({ type: 'unknown_event', data: 'test' });
    expect(parsePiJsonLine(line)).toEqual([]);
  });

  describe('message_update events', () => {
    test('parses tool_use_start into tool_use event', () => {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'tool_use_start',
          name: 'read_file',
          input: { path: '/tmp/test.ts' },
        },
      });
      const events = parsePiJsonLine(line);
      expect(events).toEqual([
        { type: 'tool_use', name: 'read_file', input: { path: '/tmp/test.ts' } },
      ]);
    });

    test('parses tool_use_end into tool_result event', () => {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'tool_use_end' },
      });
      const events = parsePiJsonLine(line);
      expect(events).toEqual([{ type: 'tool_result' }]);
    });

    test('text_delta produces no events (accumulated in message)', () => {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', text: 'hello' },
      });
      expect(parsePiJsonLine(line)).toEqual([]);
    });

    test('text_end produces no events (accumulated in message)', () => {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_end' },
      });
      expect(parsePiJsonLine(line)).toEqual([]);
    });

    test('handles missing assistantMessageEvent', () => {
      const line = JSON.stringify({ type: 'message_update' });
      expect(parsePiJsonLine(line)).toEqual([]);
    });

    test('handles unknown assistantMessageEvent type', () => {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 'something_new' },
      });
      expect(parsePiJsonLine(line)).toEqual([]);
    });

    test('skips tool_use_start when name is not a string', () => {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'tool_use_start',
          name: 42,
          input: { path: '/tmp/test.ts' },
        },
      });
      expect(parsePiJsonLine(line)).toEqual([]);
    });

    test('skips tool_use_start when input is not an object', () => {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'tool_use_start',
          name: 'read_file',
          input: 'not an object',
        },
      });
      expect(parsePiJsonLine(line)).toEqual([]);
    });

    test('skips tool_use_start when input is an array', () => {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'tool_use_start',
          name: 'read_file',
          input: [1, 2, 3],
        },
      });
      expect(parsePiJsonLine(line)).toEqual([]);
    });

    test('handles assistantMessageEvent with non-string type', () => {
      const line = JSON.stringify({
        type: 'message_update',
        assistantMessageEvent: { type: 123 },
      });
      expect(parsePiJsonLine(line)).toEqual([]);
    });

    test('accepts pre-parsed object input', () => {
      const parsed = {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'tool_use_start',
          name: 'write_file',
          input: { path: '/tmp/out.ts', content: 'hello' },
        },
      };
      const events = parsePiJsonLine(parsed);
      expect(events).toEqual([
        { type: 'tool_use', name: 'write_file', input: { path: '/tmp/out.ts', content: 'hello' } },
      ]);
    });
  });

  describe('message_end events', () => {
    test('extracts text blocks from message content', () => {
      const line = JSON.stringify({
        type: 'message_end',
        message: {
          content: [
            { type: 'text', text: 'Hello world' },
            { type: 'text', text: 'Second block' },
          ],
        },
      });
      const events = parsePiJsonLine(line);
      expect(events).toEqual([
        { type: 'text', content: 'Hello world' },
        { type: 'text', content: 'Second block' },
      ]);
    });

    test('skips non-text content blocks', () => {
      const line = JSON.stringify({
        type: 'message_end',
        message: {
          content: [
            { type: 'tool_use', name: 'read_file' },
            { type: 'text', text: 'Result' },
          ],
        },
      });
      const events = parsePiJsonLine(line);
      expect(events).toEqual([{ type: 'text', content: 'Result' }]);
    });

    test('skips text blocks with empty text', () => {
      const line = JSON.stringify({
        type: 'message_end',
        message: {
          content: [{ type: 'text', text: '' }],
        },
      });
      expect(parsePiJsonLine(line)).toEqual([]);
    });

    test('handles missing message', () => {
      const line = JSON.stringify({ type: 'message_end' });
      expect(parsePiJsonLine(line)).toEqual([]);
    });

    test('handles message with no content array', () => {
      const line = JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant' },
      });
      expect(parsePiJsonLine(line)).toEqual([]);
    });

    test('skips text blocks where text is not a string', () => {
      const line = JSON.stringify({
        type: 'message_end',
        message: {
          content: [{ type: 'text', text: 42 }],
        },
      });
      expect(parsePiJsonLine(line)).toEqual([]);
    });
  });

  describe('turn_end events', () => {
    test('extracts errors from tool results', () => {
      const line = JSON.stringify({
        type: 'turn_end',
        message: {
          toolResults: [
            { error: 'File not found: /tmp/missing.ts' },
          ],
        },
      });
      const events = parsePiJsonLine(line);
      expect(events).toEqual([
        { type: 'error', message: 'File not found: /tmp/missing.ts' },
      ]);
    });

    test('extracts multiple errors from tool results', () => {
      const line = JSON.stringify({
        type: 'turn_end',
        message: {
          toolResults: [
            { error: 'Error 1' },
            { output: 'success' },
            { error: 'Error 2' },
          ],
        },
      });
      const events = parsePiJsonLine(line);
      expect(events).toEqual([
        { type: 'error', message: 'Error 1' },
        { type: 'error', message: 'Error 2' },
      ]);
    });

    test('skips tool results without errors', () => {
      const line = JSON.stringify({
        type: 'turn_end',
        message: {
          toolResults: [{ output: 'all good' }],
        },
      });
      expect(parsePiJsonLine(line)).toEqual([]);
    });

    test('handles empty toolResults array', () => {
      const line = JSON.stringify({
        type: 'turn_end',
        message: { toolResults: [] },
      });
      expect(parsePiJsonLine(line)).toEqual([]);
    });

    test('handles missing message', () => {
      const line = JSON.stringify({ type: 'turn_end' });
      expect(parsePiJsonLine(line)).toEqual([]);
    });

    test('handles missing toolResults', () => {
      const line = JSON.stringify({
        type: 'turn_end',
        message: {},
      });
      expect(parsePiJsonLine(line)).toEqual([]);
    });
  });
});
