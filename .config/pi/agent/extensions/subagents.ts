/**
 * Subagents Extension for Pi Coding Agent
 * Inspired by nicobailon/pi-subagents
 * 
 * Provides background/synchronous subagent delegation with 4 roles:
 *  - worker: Full execution agent (edits code, runs commands)
 *  - scout: Read-only codebase explorer (find, grep, view files)
 *  - researcher: External documentation & web search agent
 *  - oracle: High-level architectural advisor & code reviewer
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { Type } from "typebox";

export interface SubagentTask {
  role: "worker" | "scout" | "researcher" | "oracle";
  prompt: string;
  cwd?: string;
  model?: string;
}

const SubagentParams = Type.Object({
  role: Type.Union([
    Type.Literal("worker"),
    Type.Literal("scout"),
    Type.Literal("researcher"),
    Type.Literal("oracle"),
  ], {
    description: "The role of the subagent to spawn."
  }),
  prompt: Type.String({
    description: "Detailed instructions and context for the subagent task."
  }),
  cwd: Type.Optional(Type.String({
    description: "Working directory for the subagent process. Defaults to current workspace."
  })),
  model: Type.Optional(Type.String({
    description: "Specific model to use for the subagent session (optional)."
  })),
});

const SubagentWaitParams = Type.Object({
  taskId: Type.Optional(Type.String({
    description: "ID of specific subagent task to wait for. If omitted, waits for all active subagent tasks."
  })),
});

interface ActiveTask {
  id: string;
  role: string;
  prompt: string;
  startTime: number;
  promise: Promise<string>;
  output: string[];
}

const ROLE_PROMPTS: Record<string, string> = {
  worker: "You are a Worker subagent. Your job is to implement code changes, create files, and execute bash commands to fulfill the task. Focus strictly on completing the task accurately.",
  scout: "You are a Scout subagent. Your job is to explore the local codebase, find relevant files, grep patterns, and inspect content. Do NOT edit files or make non-read-only changes.",
  researcher: "You are a Researcher subagent. Your job is to look up external documentation, APIs, and search the web for information needed to answer the query.",
  oracle: "You are an Oracle subagent. Your job is to provide high-level design advice, code review, or architectural guidance. Analyze carefully and return actionable insights.",
};

export default function subagentsExtension(pi: ExtensionAPI) {
  let taskCounter = 0;
  const activeTasks = new Map<string, ActiveTask>();

  function runSubagentProcess(id: string, role: string, prompt: string, cwd?: string, model?: string): Promise<string> {
    return new Promise((resolve) => {
      const systemInstruction = ROLE_PROMPTS[role] || ROLE_PROMPTS.worker;
      const combinedPrompt = `${systemInstruction}\n\nTask:\n${prompt}`;

      const args = ["--print"];
      if (model) {
        args.push("--model", model);
      }
      args.push(combinedPrompt);

      const child = spawn("pi", args, {
        cwd: cwd || process.cwd(),
        env: { ...process.env, PI_SUBAGENT_ROLE: role },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("close", (code) => {
        activeTasks.delete(id);
        if (code === 0) {
          resolve(stdout.trim() || "(Subagent finished with empty output)");
        } else {
          resolve(`Subagent [${id}] process exited with code ${code}.\nError output:\n${stderr || stdout}`);
        }
      });

      child.on("error", (err) => {
        activeTasks.delete(id);
        resolve(`Failed to spawn subagent process: ${err.message}`);
      });
    });
  }

  pi.registerTool({
    name: "subagent",
    label: "Spawn Subagent",
    description: "Spawn an isolated subagent in the background or foreground to handle a specific role (worker, scout, researcher, oracle).",
    parameters: SubagentParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      taskCounter++;
      const id = `subagent-${taskCounter}`;
      const { role, prompt, cwd, model } = params;

      const promise = runSubagentProcess(id, role, prompt, cwd, model);

      const task: ActiveTask = {
        id,
        role,
        prompt,
        startTime: Date.now(),
        promise,
        output: [],
      };

      activeTasks.set(id, task);

      return {
        content: [{
          type: "text",
          text: `Subagent [${id}] of role '${role}' spawned in background.\nUse 'subagent_wait' with taskId: "${id}" to retrieve its result.`
        }],
        details: { taskId: id, role, prompt }
      };
    }
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagent",
    description: "Wait for background subagent task(s) to complete and retrieve their results.",
    parameters: SubagentWaitParams,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { taskId } = params;

      if (taskId) {
        const task = activeTasks.get(taskId);
        if (!task) {
          return {
            content: [{ type: "text", text: `No active subagent found with taskId: ${taskId}` }]
          };
        }
        const result = await task.promise;
        return {
          content: [{ type: "text", text: `### Result from Subagent [${taskId}] (${task.role})\n\n${result}` }]
        };
      }

      if (activeTasks.size === 0) {
        return {
          content: [{ type: "text", text: "No active background subagents running." }]
        };
      }

      const taskIds = Array.from(activeTasks.keys());
      const results: string[] = [];

      for (const id of taskIds) {
        const task = activeTasks.get(id);
        if (task) {
          const res = await task.promise;
          results.push(`### Subagent [${id}] (${task.role})\n${res}`);
        }
      }

      return {
        content: [{ type: "text", text: results.join("\n\n---\n\n") }]
      };
    }
  });
}
