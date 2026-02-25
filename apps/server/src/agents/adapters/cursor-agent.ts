import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { parseThreadConversationState } from "@farfield/protocol";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentCreateThreadInput,
  AgentCreateThreadResult,
  AgentInterruptInput,
  AgentListThreadsInput,
  AgentListThreadsResult,
  AgentReadThreadInput,
  AgentReadThreadResult,
  AgentSendMessageInput
} from "../types.js";

export interface CursorAgentOptions {
  executablePath?: string;
  workspaceDir?: string;
}

const CursorThreadListItemSchema = z
  .object({
    id: z.string().min(1),
    preview: z.string(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    cwd: z.string().optional(),
    source: z.literal("cursor")
  })
  .strict();

type CursorThreadListItem = z.infer<typeof CursorThreadListItemSchema>;

interface CursorThreadRecord {
  thread: CursorThreadListItem;
  turns: NonNullable<AgentReadThreadResult["thread"]>["turns"];
  latestModel: string | null;
}

const CursorPrintResultSchema = z
  .object({
    type: z.literal("result"),
    subtype: z.string(),
    is_error: z.boolean(),
    result: z.string(),
    session_id: z.string().min(1),
    request_id: z.string().min(1),
    model: z.string().optional()
  })
  .passthrough();

const ANSI_ESCAPE_REGEX = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export class CursorAgentAdapter implements AgentAdapter {
  public readonly id = "cursor";
  public readonly label = "Cursor";
  public readonly capabilities: AgentCapabilities = {
    canListModels: false,
    canListCollaborationModes: false,
    canSetCollaborationMode: false,
    canSubmitUserInput: false,
    canReadLiveState: false,
    canReadStreamEvents: false
  };

  private readonly executablePath: string;
  private readonly workspaceDir: string;
  private connected = false;
  private readonly records = new Map<string, CursorThreadRecord>();
  private readonly activeByThreadId = new Map<string, ChildProcessWithoutNullStreams>();

  public constructor(options: CursorAgentOptions = {}) {
    this.executablePath = options.executablePath ?? "cursor-agent";
    this.workspaceDir = path.resolve(options.workspaceDir ?? process.cwd());
  }

  public async start(): Promise<void> {
    await this.runCommand(["--version"]);
    this.connected = true;
  }

  public async stop(): Promise<void> {
    this.connected = false;
    for (const child of this.activeByThreadId.values()) {
      child.kill("SIGTERM");
    }
    this.activeByThreadId.clear();
  }

  public isEnabled(): boolean {
    return true;
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async listThreads(input: AgentListThreadsInput): Promise<AgentListThreadsResult> {
    this.ensureConnected();
    const offset = parseCursorOffset(input.cursor);
    const allThreads = Array.from(this.records.values())
      .map((record) => record.thread)
      .sort((left, right) => right.updatedAt - left.updatedAt);

    const limit = Math.max(1, input.limit);
    const page = allThreads.slice(offset, offset + limit);
    const nextOffset = offset + page.length;

    return {
      data: page,
      nextCursor: nextOffset < allThreads.length ? String(nextOffset) : null
    };
  }

  public async createThread(input: AgentCreateThreadInput): Promise<AgentCreateThreadResult> {
    this.ensureConnected();
    const cwd = input.cwd ? normalizeDirectoryInput(input.cwd) : undefined;

    const result = await this.runCommand([
      ...workspaceArgs(cwd, this.workspaceDir),
      "create-chat"
    ]);
    const threadId = parseChatId(result.stdout);
    const now = Date.now();

    const thread = CursorThreadListItemSchema.parse({
      id: threadId,
      preview: "(untitled)",
      createdAt: now,
      updatedAt: now,
      ...(cwd ? { cwd } : {}),
      source: "cursor"
    });

    this.records.set(threadId, {
      thread,
      turns: [],
      latestModel: null
    });

    return {
      threadId,
      thread,
      ...(cwd ? { cwd } : {})
    };
  }

  public async readThread(input: AgentReadThreadInput): Promise<AgentReadThreadResult> {
    this.ensureConnected();
    const record = this.requireRecord(input.threadId);

    const thread = parseThreadConversationState({
      id: record.thread.id,
      turns: input.includeTurns ? record.turns : [],
      requests: [],
      createdAt: record.thread.createdAt,
      updatedAt: record.thread.updatedAt,
      title: null,
      latestModel: record.latestModel,
      ...(record.thread.cwd ? { cwd: record.thread.cwd } : {}),
      source: "cursor"
    });

    return { thread };
  }

  public async sendMessage(input: AgentSendMessageInput): Promise<void> {
    this.ensureConnected();
    const record = this.requireRecord(input.threadId);
    const cwd = input.cwd ? normalizeDirectoryInput(input.cwd) : record.thread.cwd;

    const result = await this.runCommand(
      [
        "--print",
        "--output-format",
        "json",
        "--resume",
        input.threadId,
        "--trust",
        ...workspaceArgs(cwd, this.workspaceDir),
        input.text
      ],
      input.threadId
    );

    const payload = parseCursorPrintResult(result.stdout);
    if (payload.is_error) {
      throw new Error(normalizeAssistantText(payload.result) || "Cursor request failed");
    }

    const now = Date.now();
    const turnId = `cursor-${payload.request_id}`;
    const assistantText = normalizeAssistantText(payload.result);

    record.turns.push({
      id: turnId,
      turnId,
      status: "completed",
      turnStartedAtMs: now,
      finalAssistantStartedAtMs: now,
      error: null,
      diff: null,
      items: [
        {
          id: `${turnId}-user`,
          type: "userMessage",
          content: [{
            type: "text",
            text: input.text
          }]
        },
        {
          id: `${turnId}-assistant`,
          type: "agentMessage",
          text: assistantText
        }
      ]
    });

    record.thread = CursorThreadListItemSchema.parse({
      ...record.thread,
      preview: summarizePreview(input.text),
      updatedAt: now,
      ...(cwd ? { cwd } : {}),
      source: "cursor"
    });
    record.latestModel = payload.model ?? record.latestModel;
  }

  public async interrupt(input: AgentInterruptInput): Promise<void> {
    this.ensureConnected();
    const active = this.activeByThreadId.get(input.threadId);
    if (!active) {
      throw new Error(`No active Cursor request for thread ${input.threadId}`);
    }
    active.kill("SIGTERM");
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error("Cursor agent is not connected");
    }
  }

  private requireRecord(threadId: string): CursorThreadRecord {
    const record = this.records.get(threadId);
    if (!record) {
      throw new Error(`Unknown Cursor thread: ${threadId}`);
    }
    return record;
  }

  private runCommand(
    args: string[],
    threadId?: string
  ): Promise<{
    stdout: string;
    stderr: string;
  }> {
    return new Promise((resolve, reject) => {
      if (threadId && this.activeByThreadId.has(threadId)) {
        reject(new Error(`Cursor thread ${threadId} already has an active request`));
        return;
      }

      const child = spawn(this.executablePath, args, {
        cwd: this.workspaceDir,
        env: {
          ...process.env,
          NO_COLOR: "1"
        },
        stdio: ["pipe", "pipe", "pipe"]
      });

      if (threadId) {
        this.activeByThreadId.set(threadId, child);
      }

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        if (threadId) {
          this.activeByThreadId.delete(threadId);
        }
        reject(error);
      });

      child.on("close", (code) => {
        if (threadId) {
          this.activeByThreadId.delete(threadId);
        }

        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        const details = stripAnsi(`${stderr}\n${stdout}`).trim();
        const summary = details.length > 0 ? details : "unknown error";
        reject(new Error(`cursor-agent ${args.join(" ")} failed (${String(code)}): ${summary}`));
      });
    });
  }
}

function normalizeDirectoryInput(directory: string): string {
  const trimmed = directory.trim();
  if (trimmed.length === 0) {
    throw new Error("Directory is required");
  }

  const resolved = path.resolve(trimmed);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }
  const stats = fs.statSync(resolved);
  if (!stats.isDirectory()) {
    throw new Error(`Path is not a directory: ${resolved}`);
  }
  return resolved;
}

function workspaceArgs(directory: string | undefined, defaultWorkspaceDir: string): string[] {
  return ["--workspace", directory ?? defaultWorkspaceDir];
}

function parseCursorOffset(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }

  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid cursor value: ${cursor}`);
  }
  return parsed;
}

function parseChatId(stdout: string): string {
  const lines = toNonEmptyLines(stripAnsi(stdout));
  const lastLine = lines[lines.length - 1];
  return z.string().min(1).parse(lastLine);
}

function parseCursorPrintResult(stdout: string): z.infer<typeof CursorPrintResultSchema> {
  const lines = toNonEmptyLines(stripAnsi(stdout));

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      const candidate = CursorPrintResultSchema.safeParse(parsed);
      if (candidate.success) {
        return candidate.data;
      }
    } catch {
      continue;
    }
  }

  throw new Error("Cursor did not return a JSON result payload");
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEX, "");
}

function toNonEmptyLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function normalizeAssistantText(value: string): string {
  return value.replace(/^\s+/u, "").replace(/\s+$/u, "");
}

function summarizePreview(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    return "(untitled)";
  }
  return normalized.length > 80 ? `${normalized.slice(0, 80)}...` : normalized;
}
