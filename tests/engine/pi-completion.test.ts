/**
 * ABOUTME: Regression tests for Pi completion signals and publication eligibility.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutionEngine } from '../../src/engine/index.js';
import type { IterationResult } from '../../src/engine/types.js';
import type { RalphConfig } from '../../src/config/types.js';
import { PiAgentPlugin } from '../../src/plugins/agents/builtin/pi.js';
import type { AgentExecutionResult } from '../../src/plugins/agents/types.js';
import type { TrackerPlugin, TrackerTask } from '../../src/plugins/trackers/types.js';

const marker = '<promise>COMPLETE</promise>';

function message(role: string, text: string, stopReason = 'stop'): string {
  return JSON.stringify({
    type: 'message_end',
    message: { role, content: [{ type: 'text', text }], stopReason },
  });
}

async function runIteration(overrides: Partial<AgentExecutionResult>) {
  const cwd = await mkdtemp(join(tmpdir(), 'ralph-pi-completion-'));
  const task: TrackerTask = { id: 'edit-safety', title: 'Preserve edits', status: 'open', priority: 1 };
  const completed: string[] = [];
  const committed: string[] = [];
  const agent = new PiAgentPlugin();
  agent.execute = () => ({
    executionId: 'test-execution',
    promise: Promise.resolve({
      executionId: 'test-execution',
      status: 'completed',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 0,
      interrupted: false,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      ...overrides,
    }),
    interrupt: () => undefined,
    isRunning: () => false,
  });
  const tracker = {
    getTemplate: () => 'Task: {{taskId}}',
    getPrdContext: async () => null,
    getTasks: async () => [],
    updateTaskStatus: async () => task,
    completeTask: async (id: string) => {
      completed.push(id);
      return { success: true, message: 'Completed', task };
    },
  } as unknown as TrackerPlugin;
  const config: RalphConfig = {
    cwd,
    agent: { name: 'pi', plugin: 'pi', options: {} },
    tracker: { name: 'json', plugin: 'json', options: {} },
    maxIterations: 1,
    iterationDelay: 0,
    watch: false,
    pollIntervalMs: 30000,
    outputDir: join(cwd, 'output'),
    progressFile: join(cwd, 'progress.md'),
    showTui: false,
    autoCommit: true,
    errorHandling: {
      strategy: 'abort',
      maxRetries: 0,
      retryDelayMs: 0,
      continueOnNonZeroExit: false,
    },
  };
  const engine = new ExecutionEngine(config);
  const internals = engine as unknown as {
    agent: PiAgentPlugin;
    tracker: TrackerPlugin;
    runIteration: (task: TrackerTask) => Promise<IterationResult>;
    handleAutoCommit: (task: TrackerTask) => Promise<void>;
  };
  internals.agent = agent;
  internals.tracker = tracker;
  internals.handleAutoCommit = async (candidate) => { committed.push(candidate.id); };

  try {
    const result = await internals.runIteration(task);
    return { result, completed, committed };
  } finally {
    await engine.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('Pi completion eligibility', () => {
  test.each(['user', 'toolResult'])('should leave work incomplete when %s output contains the marker', async (role) => {
    const stdout = [message(role, marker), message('assistant', 'BLOCKED: verification failed')].join('\n');

    const { result, completed, committed } = await runIteration({ stdout });

    expect(result.taskCompleted, 'Echoed content must not complete the task').toBe(false);
    expect(completed, 'The tracker must remain incomplete').toEqual([]);
    expect(committed, 'Partial work must not be automatically committed').toEqual([]);
  });

  test('should leave work incomplete when an earlier assistant marker is followed by a blocker', async () => {
    const stdout = [message('assistant', marker), message('assistant', 'BLOCKED')].join('\n');

    const { result, completed, committed } = await runIteration({ stdout });

    expect(result.taskCompleted, 'Only the final response can authorize completion').toBe(false);
    expect(completed, 'A later blocker must preserve the open task').toEqual([]);
    expect(committed, 'An intermediate marker must not authorize a commit').toEqual([]);
  });

  test.each(['failed', 'timeout', 'interrupted', 'running'] as const)(
    'should leave work incomplete when execution status is %s despite a final marker',
    async (status) => {
      const stdout = message('assistant', marker);

      const { result, completed, committed } = await runIteration({ stdout, status });

      expect(result.taskCompleted, 'Only successful execution can complete work').toBe(false);
      expect(completed, 'Unsuccessful execution must not update completion').toEqual([]);
      expect(committed, 'Unsuccessful execution must not auto-commit').toEqual([]);
    },
  );

  test('should leave work incomplete when an otherwise successful execution was interrupted', async () => {
    const stdout = message('assistant', marker);

    const { result, committed } = await runIteration({ stdout, interrupted: true });

    expect(result.taskCompleted, 'Interruption must invalidate completion').toBe(false);
    expect(committed, 'Interrupted work must not auto-commit').toEqual([]);
  });

  test('should leave work incomplete when the process exited unsuccessfully despite completed status', async () => {
    const stdout = message('assistant', marker);

    const { result, committed } = await runIteration({ stdout, exitCode: 1 });

    expect(result.taskCompleted, 'A nonzero process exit must invalidate completion').toBe(false);
    expect(committed, 'A nonzero process exit must prevent auto-commit').toEqual([]);
  });

  test('should complete and permit auto-commit when a successful final assistant response signals completion', async () => {
    const stdout = [message('user', marker), message('assistant', marker)].join('\n');

    const { result, completed, committed } = await runIteration({ stdout });

    expect(result.taskCompleted, 'The successful final marker must complete work').toBe(true);
    expect(completed, 'Verified completion must reach the tracker').toEqual(['edit-safety']);
    expect(committed, 'Eligible completion must reach auto-commit').toEqual(['edit-safety']);
  });
});
