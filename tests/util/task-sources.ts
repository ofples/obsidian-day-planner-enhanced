import { writable } from "svelte/store";
import { vi } from "vitest";

import { defaultSettings } from "../../src/settings";
import type { GitHubBackend } from "../../src/tasks/github-backend";
import type { TaskBrowserState, TaskService } from "../../src/tasks/service";
import { TaskSourceCollection } from "../../src/tasks/source-collection";
import { googleTaskId } from "../../src/tasks/source-references";
import {
  TaskSourceSession,
  type TaskSourceBackend,
} from "../../src/tasks/source-session";
import type { ProviderTask, TaskSnapshot } from "../../src/tasks/types";

export async function taskSourcesFixture() {
  const settings = writable(structuredClone(defaultSettings));
  const state = writable<TaskBrowserState>({
    snapshot: null,
    connected: false,
    readOnly: true,
    writable: false,
    loading: false,
    error: "",
    operations: [],
    completed: [],
    aliases: {},
  });
  const mutate = vi.fn(async () => {
    throw new Error("An external task entered Todoist synchronization");
  });
  const service = {
    state,
    refresh: vi.fn(async () => {}),
    mutate,
    registry: {
      snapshot: () => ({
        namespace: "a".repeat(32),
        schedules: [],
        projections: {},
        links: {},
      }),
    },
  } as unknown as TaskService;
  const task = (id: string, title: string): ProviderTask => ({
    id,
    title,
    description: "Supporting details",
    projectId: "work",
    parentId: null,
    labels: ["work"],
    priority: 1,
    completed: false,
    order: 0,
    due: null,
  });
  const googleTask = {
    ...task(googleTaskId("work", "parent"), "Google work"),
    source: {
      kind: "task" as const,
      nativeId: "parent",
      nativeContainerId: "work",
      url: "https://tasks.google.com/task/opaque?identity=kept",
    },
  };
  const child = {
    ...task(googleTaskId("work", "child"), "Child work"),
    description: "Child notes",
    parentId: googleTask.id,
    order: 1,
  };
  const githubTask = {
    ...task("issue-node", "GitHub work"),
    source: {
      kind: "issue" as const,
      nativeId: "issue-node",
      nativeContainerId: "example/work",
      url: "https://github.com/example/work/issues/7",
      number: 7,
      private: false,
      assignedToMe: true,
    },
  };
  const snapshot = (provider: string, tasks: ProviderTask[]): TaskSnapshot => ({
    provider,
    account: {
      id: `${provider}-account`,
      name: "Fixture",
      timezone: "UTC",
      capabilities: { complete: provider === "google-tasks" },
    },
    projects: [{ id: "work", name: "Work", order: 0 }],
    tasks,
    fetchedAt: new Date().toISOString(),
  });
  const googleSnapshot = snapshot("google-tasks", [googleTask, child]);
  const githubSnapshot = snapshot("github", [githubTask]);
  function session(snapshot: TaskSnapshot) {
    let connected = true;
    const result = { snapshot, coverage: { complete: true, streams: [] } };
    const backend: TaskSourceBackend = {
      connected: () => connected,
      accountId: () => snapshot.account.id,
      connect: vi.fn(async () => {
        connected = true;
        return result;
      }),
      read: vi.fn(async () => result),
      cancel: vi.fn(),
      disconnect: vi.fn(() => {
        connected = false;
      }),
      complete: vi.fn(async (task) => ({ ...task, completed: true })),
      get: vi.fn(async (task) => ({ ...task, completed: true })),
    };
    return {
      backend,
      session: new TaskSourceSession(snapshot.provider, backend, {
        read: async () => ({ ...result, verificationRequired: [] }),
        write: async () => {},
      }),
    };
  }
  const google = session(googleSnapshot);
  const github = session(githubSnapshot);
  const githubBackend = {
    auth: { device: writable(null), grantedScopes: () => [] },
    discoverProjects: vi.fn(async () => ({ items: [] })),
    lookupProject: vi.fn(),
  } as unknown as GitHubBackend;
  const sources = new TaskSourceCollection(
    service,
    google.session,
    github.session,
    githubBackend,
    settings,
  );
  await sources.initialize();
  return {
    sources,
    settings,
    service,
    mutate,
    google,
    github,
    googleSnapshot,
    githubSnapshot,
    googleTask,
    child,
    githubTask,
  };
}
