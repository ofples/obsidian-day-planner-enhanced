import { describe, expect, test, vi } from "vitest";

import { GitHubProvider } from "../src/tasks/github";
import {
  githubProjectLocation,
  githubRepository,
  githubSelectionSchema,
} from "../src/tasks/github-config";
import { githubTaskView } from "../src/tasks/github-view";
import type { SourceRequest } from "../src/tasks/source-http";
import { resolveSourceTask } from "../src/tasks/source-references";
import { TaskReadError } from "../src/tasks/types";

const pageInfo = { hasNextPage: false, endCursor: null };
const account = { id: "user-node", name: "Test", timezone: "Asia/Kolkata" };
const created = "2026-11-19T00:00:00Z";
const issue = (id: string, patch: Record<string, unknown> = {}) => ({
  node_id: id,
  title: id,
  number: 7,
  body: "Details\n\n- [ ] Check result",
  html_url: "https://github.com/example/work/issues/7",
  state: "open",
  created_at: created,
  updated_at: created,
  labels: [{ name: "work" }],
  assignees: [{ login: "reader" }],
  repository: { private: false },
  ...patch,
});
const content = (id: string, patch: Record<string, unknown> = {}) => ({
  __typename: "Issue",
  id,
  title: id,
  body: "Supporting details",
  url: "https://github.com/example/work/issues/7",
  number: 7,
  state: "OPEN",
  createdAt: created,
  updatedAt: created,
  repository: { nameWithOwner: "example/work", isPrivate: false },
  labels: { nodes: [{ name: "work" }] },
  assignees: { nodes: [{ login: "reader" }] },
  ...patch,
});
const item = (
  id: string,
  value: ReturnType<typeof content> | null,
  status = "ready",
  target = "2026-11-20",
) => ({
  id,
  content: value,
  isArchived: false,
  fieldValues: {
    nodes: [
      {
        __typename: "ProjectV2ItemFieldSingleSelectValue",
        field: { id: "status-field" },
        optionId: status,
        name: status,
      },
      {
        __typename: "ProjectV2ItemFieldDateValue",
        field: { id: "date-field" },
        date: target,
      },
    ],
    pageInfo,
  },
});
const project = (
  id: string,
  nodes: Array<ReturnType<typeof item>>,
  patch: Record<string, unknown> = {},
) => ({
  __typename: "ProjectV2",
  id,
  title: id,
  url: `https://github.com/users/reader/projects/${id === "project-one" ? 1 : 2}`,
  fields: {
    nodes: [
      {
        id: "status-field",
        name: "Workflow",
        dataType: "SINGLE_SELECT",
        options: [
          { id: "ready", name: "Ready" },
          { id: "doing", name: "In progress" },
        ],
      },
      { id: "date-field", name: "Target", dataType: "DATE" },
    ],
    pageInfo,
  },
  items: { nodes, pageInfo },
  ...patch,
});
const selection = () =>
  githubSelectionSchema.parse({
    repositories: ["example/work"],
    projects: [
      {
        id: "project-one",
        title: "One",
        url: "https://github.com/users/reader/projects/1",
        statusFieldId: "status-field",
        dateFieldId: "date-field",
      },
      {
        id: "project-two",
        title: "Two",
        url: "https://github.com/orgs/example/projects/2",
        statusFieldId: "status-field",
        dateFieldId: "date-field",
      },
    ],
  });

describe("GitHub planning source", () => {
  test("deduplicates assignment/repository/Projects while preserving independent field values and kinds", async () => {
    const request = vi.fn<SourceRequest>(async (path, options) => {
      if (path === "/repos/example/work") return { private: false };
      if (!options)
        return [
          issue("issue-node"),
          issue("ignored-pr", {
            pull_request: {
              url: "https://api.github.com/repos/example/work/pulls/8",
            },
          }),
        ];
      const body = options.body as { query: string; variables: { id: string } };
      expect(body.query.trimStart().startsWith("query ")).toBe(true);
      const id = body.variables.id;
      return {
        data: {
          node:
            id === "project-one"
              ? project(id, [
                  item("item-one", content("issue-node")),
                  item(
                    "draft-item",
                    content("draft-content", {
                      __typename: "DraftIssue",
                      repository: undefined,
                      url: undefined,
                      number: undefined,
                    }),
                  ),
                  item(
                    "pr-item",
                    content("pr-node", {
                      __typename: "PullRequest",
                      number: 9,
                      url: "https://github.com/example/work/pull/9",
                    }),
                  ),
                  item("redacted", null),
                ])
              : project(id, [
                  item(
                    "item-two",
                    content("issue-node"),
                    "doing",
                    "2026-11-22",
                  ),
                ]),
        },
      };
    });
    const result = await new GitHubProvider(
      request,
      account,
      "reader",
      selection,
    ).read();
    expect(result.snapshot.tasks.map((task) => task.id)).toEqual([
      "issue-node",
      "draft-item",
      "pr-node",
    ]);
    expect(result.snapshot.tasks[0]?.source?.memberships).toHaveLength(4);
    expect(result.snapshot.tasks[0]?.priority).toBe(1);
    expect(result.snapshot.tasks[0]?.due).toBeNull();
    expect(result.snapshot.tasks[0]?.labels).toEqual(["work"]);
    expect(result.snapshot.tasks[1]?.source?.kind).toBe("draft");
    expect(result.snapshot.tasks[2]?.source?.kind).toBe("pull-request");
    expect(result.coverage.unavailableItems).toBe(1);
    expect(result.coverage.complete).toBe(true);
    const one = githubTaskView(result.snapshot, {
      kind: "project",
      id: "project-one",
      statusOptionIds: ["ready"],
    });
    const two = githubTaskView(result.snapshot, {
      kind: "project",
      id: "project-two",
      statusOptionIds: ["doing"],
    });
    expect(one.tasks[0]?.due?.date).toBe("2026-11-20");
    expect(two.tasks[0]?.due?.date).toBe("2026-11-22");
    expect(two.tasks[0]?.source?.state).toBe("open");
    expect(result.snapshot.tasks[0]?.due).toBeNull();
    expect(
      githubTaskView(result.snapshot, {
        kind: "project",
        id: "project-two",
        statusOptionIds: ["ready"],
      }).tasks,
    ).toEqual([]);
    expect(
      request.mock.calls
        .filter(([, options]) => options)
        .every(([, options]) => options?.method === "POST"),
    ).toBe(true);
  });

  test("keeps inaccessible containers scoped and recognizes field IDs after rename", async () => {
    const request = vi.fn<SourceRequest>(async (path, options) => {
      if (!options) {
        if (path.startsWith("/repos/"))
          throw new TaskReadError(
            "Organization approval needed",
            undefined,
            false,
            403,
          );
        return [issue("issue-node")];
      }
      const { variables } = options.body as { variables: { id: string } };
      if (variables.id === "project-two")
        return { data: { node: null }, errors: [{ type: "FORBIDDEN" }] };
      const data = project("project-one", [
        item("item-one", content("issue-node")),
      ]);
      data.fields.nodes[0]!.name = "Renamed workflow";
      return { data: { node: data } };
    });
    const result = await new GitHubProvider(
      request,
      account,
      "reader",
      selection,
    ).read();
    expect(result.snapshot.tasks).toHaveLength(1);
    expect(result.coverage.complete).toBe(false);
    expect(
      result.coverage.streams.filter((stream) => stream.error),
    ).toHaveLength(2);
    expect(
      result.snapshot.tasks[0]?.source?.memberships?.find(
        (member) => member.containerId === "project-one",
      )?.status?.fieldId,
    ).toBe("status-field");
    expect(
      result.snapshot.projects.find((entry) => entry.id === "project-one")
        ?.source?.fields?.[0]?.name,
    ).toBe("Renamed workflow");
  });

  test("bounded REST reads resume using the same page size without repeating completed streams", async () => {
    const request = vi.fn<SourceRequest>(async (path) => {
      const url = new URL(path, "https://api.github.com");
      expect(url.searchParams.get("per_page")).toBe("100");
      const page = Number(url.searchParams.get("page"));
      return page <= 20
        ? Array.from({ length: 100 }, (_, index) =>
            issue(`issue-${page}-${index}`),
          )
        : [];
    });
    const provider = new GitHubProvider(request, account, "reader", () =>
      githubSelectionSchema.parse({}),
    );
    const first = await provider.read();
    expect(first.snapshot.tasks).toHaveLength(2000);
    expect(first.coverage.complete).toBe(false);
    expect(request).toHaveBeenCalledTimes(20);
    const second = await provider.read(first);
    expect(second.snapshot.tasks).toHaveLength(2000);
    expect(second.coverage.complete).toBe(true);
    expect(request).toHaveBeenCalledTimes(21);
  });

  test("draft conversion resolves the old item reference to the current issue", async () => {
    let converted = false;
    const request: SourceRequest = async () => ({
      data: {
        node: project("project-one", [
          item(
            "draft-item",
            content(
              converted ? "issue-node" : "draft-content",
              converted
                ? {}
                : {
                    __typename: "DraftIssue",
                    repository: undefined,
                    url: undefined,
                    number: undefined,
                  },
            ),
          ),
        ]),
      },
    });
    const provider = new GitHubProvider(request, account, "reader", () => ({
      ...selection(),
      assigned: false,
      repositories: [],
      projects: selection().projects.slice(0, 1),
    }));
    expect((await provider.read()).snapshot.tasks[0]?.id).toBe("draft-item");
    converted = true;
    const result = await provider.read();
    expect(result.snapshot.tasks).toHaveLength(1);
    expect(
      resolveSourceTask([result.snapshot], {
        provider: "github",
        accountId: account.id,
        itemId: "draft-item",
      })?.task.id,
    ).toBe("issue-node");
  });

  test("Project discovery and explicit owner URLs use fixed query variables", async () => {
    const request = vi.fn<SourceRequest>(async (_path, options) => {
      const body = options?.body as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (body.query.includes("DayPlannerProjects("))
        return {
          data: {
            viewer: {
              projectsV2: {
                nodes: [
                  {
                    id: "project-one",
                    title: "One",
                    url: "https://github.com/users/reader/projects/1",
                  },
                ],
                pageInfo,
              },
            },
          },
        };
      expect(body.variables).toEqual({ login: "example", number: 2 });
      return {
        data: {
          organization: {
            projectV2: {
              id: "project-two",
              title: "Two",
              url: "https://github.com/orgs/example/projects/2",
            },
          },
        },
      };
    });
    const provider = new GitHubProvider(request, account, "reader", selection);
    expect((await provider.discoverProjects()).items[0]?.id).toBe(
      "project-one",
    );
    expect(
      (
        await provider.lookupProject(
          "https://github.com/orgs/example/projects/2",
        )
      ).id,
    ).toBe("project-two");
    await expect(
      provider.lookupProject("https://another.example/orgs/example/projects/2"),
    ).rejects.toThrow(/github.com/);
    expect(githubRepository("https://github.com/Example/Work/")).toBe(
      "example/work",
    );
    expect(githubRepository("example/work/../../secrets")).toBeUndefined();
    expect(
      githubProjectLocation(
        "https://github.com/users/reader/projects/1?pane=issue",
      ),
    ).toEqual({ kind: "user", owner: "reader", number: 1 });
  });

  test("private items stay out of the cached source until private access is explicitly enabled", async () => {
    const request: SourceRequest = async (_path, options) =>
      options
        ? {
            data: {
              node: project("project-one", [
                item(
                  "private-item",
                  content("private-issue", {
                    repository: {
                      nameWithOwner: "example/private",
                      isPrivate: true,
                    },
                  }),
                ),
              ]),
            },
          }
        : [issue("private-issue", { repository: { private: true } })];
    const selected = () => ({
      ...selection(),
      repositories: [],
      projects: selection().projects.slice(0, 1),
    });
    const hidden = await new GitHubProvider(
      request,
      account,
      "reader",
      selected,
    ).read();
    expect(hidden.snapshot.tasks).toEqual([]);
    expect(hidden.coverage.unavailableItems).toBe(2);
    const visible = await new GitHubProvider(
      request,
      account,
      "reader",
      selected,
      () => true,
    ).read();
    expect(visible.snapshot.tasks).toHaveLength(1);
    expect(visible.snapshot.tasks[0]?.source?.private).toBe(true);
  });
});
