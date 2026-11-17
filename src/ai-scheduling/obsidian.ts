import { DateTime } from "luxon";
import { MarkdownView, type Plugin } from "obsidian";
import { get } from "svelte/store";

import type { GoogleCalendarSync } from "../google-calendar/service";
import type { LocalIdentity } from "../google-calendar/types";
import type { OptimisticNoteEdits } from "../service/optimistic-note-edits";
import type { PeriodicNotes } from "../service/periodic-notes";
import type { DayPlannerSettings } from "../settings";
import { parseCaptureCandidates } from "../tasks/capture-parser";
import type { TaskScheduler } from "../tasks/schedule";
import type { TaskService } from "../tasks/service";
import { taskLinkIdentity } from "../tasks/weak-links";
import type { RemoteTimeBlock, WithDuration } from "../time-block-types";

import { buildPlanningContext } from "./context";
import { buildPlanningBatch } from "./markdown";
import {
  PlanningUndoBlockedError,
  type PlanningDraft,
  type PlanningHost,
  type PlanningReceipt,
  type PlanningRequest,
} from "./service";
import {
  planningPreferencesSchema,
  type PlanningCommitment,
  type PlanningContext,
  type PlanningTask,
} from "./types";
import { PlanningValidationError, validateProposal } from "./validation";

interface PlanningHostOptions {
  plugin: Plugin;
  daily: PeriodicNotes;
  calendar: GoogleCalendarSync;
  tasks: TaskService;
  scheduler(): TaskScheduler | undefined;
  settings(): DayPlannerSettings;
  range(): { startDate: string; dayCount: number };
  sourcePaths(): string[];
  commitments(
    startDate: string,
    dayCount: number,
  ): Promise<Array<WithDuration<RemoteTimeBlock>>>;
  preview: Pick<OptimisticNoteEdits, "begin">;
}

/** Desktop adapter. Local writes and Calendar cleanup share the established note queue. */
export class ObsidianPlanningHost implements PlanningHost {
  constructor(private readonly options: PlanningHostOptions) {}

  private statePath() {
    const { plugin } = this.options;
    return `${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/ai-planning.json`;
  }

  async readState() {
    const adapter = this.options.plugin.app.vault.adapter;
    return (await adapter.exists(this.statePath()))
      ? adapter.read(this.statePath())
      : null;
  }

  writeState(text: string) {
    return this.options.plugin.app.vault.adapter.write(this.statePath(), text);
  }

  async backupState() {
    const adapter = this.options.plugin.app.vault.adapter;
    if (await adapter.exists(this.statePath())) {
      const text = await adapter.read(this.statePath());
      await adapter.write(
        this.statePath().replace(/\.json$/, `.backup-${Date.now()}.json`),
        text,
      );
    }
  }

  defaults() {
    return {
      ...this.options.range(),
      request: "",
      preferences: planningPreferencesSchema.parse({
        defaultDurationMinutes: this.options.settings().defaultDurationMinutes,
      }),
    };
  }

  private async readDocument(path: string) {
    const { app } = this.options.plugin;
    for (const leaf of app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view.file?.path === path) return view.editor.getValue();
    }
    const file = app.vault.getFileByPath(path);
    return file ? app.vault.read(file) : null;
  }

  async readDocuments(paths: string[]): Promise<Record<string, string | null>> {
    return Object.fromEntries(
      await Promise.all(
        [...new Set(paths)].map(
          async (path): Promise<[string, string | null]> => [
            path,
            await this.readDocument(path),
          ],
        ),
      ),
    );
  }

  private async flush(paths: string[]) {
    for (const leaf of this.options.plugin.app.workspace.getLeavesOfType(
      "markdown",
    )) {
      const view = leaf.view as MarkdownView;
      if (view.file && paths.includes(view.file.path)) await view.save();
    }
  }

  private async calendarCommitments(
    startDate: string,
    dayCount: number,
  ): Promise<PlanningCommitment[]> {
    const start = window.moment(startDate, "YYYY-MM-DD").startOf("day");
    const end = start.clone().add(dayCount, "days");
    const commitments = await this.options.commitments(startDate, dayCount);
    return commitments
      .filter(
        (block) =>
          block.startTime.isBefore(end) &&
          block.startTime
            .clone()
            .add(block.durationMinutes, "minutes")
            .isAfter(start),
      )
      .map((block) => ({
        ref: block.id,
        title: block.summary,
        start: block.startTime.toISOString(),
        end: block.startTime
          .clone()
          .add(block.durationMinutes, "minutes")
          .toISOString(),
        allDay: Boolean(block.isAllDayEvent),
      }));
  }

  private providerTasks(
    excluded: Set<string>,
  ): Array<Omit<PlanningTask, "ref">> {
    const snapshot = get(this.options.tasks.state).snapshot;
    const scheduler = this.options.scheduler();
    if (!snapshot || !scheduler) return [];
    return snapshot.tasks
      .filter((task) => !task.completed && !excluded.has(task.id))
      .slice(0, 500)
      .map((task) => {
        const serialized = scheduler.plainCachedTask(task.id);
        return {
          kind: "todoist",
          title: task.title,
          raw: serialized.raw,
          provider: snapshot.provider,
          accountId: snapshot.account.id,
          taskId: task.id,
          taskIds: serialized.taskIds,
          priority: task.priority,
          due: task.due?.date ?? null,
          ...(task.duration
            ? {
                durationMinutes:
                  task.duration.unit === "minute"
                    ? task.duration.amount
                    : task.duration.amount * 1440,
              }
            : {}),
          project:
            snapshot.projects.find((project) => project.id === task.projectId)
              ?.name ?? "",
          labels: task.labels,
          fingerprint: JSON.stringify(task),
        };
      });
  }

  async context(request: PlanningRequest): Promise<PlanningContext> {
    const defaults = this.defaults();
    const startDate = request.startDate ?? defaults.startDate;
    const dayCount = request.dayCount ?? defaults.dayCount;
    const preferences = planningPreferencesSchema.parse({
      ...defaults.preferences,
      ...request.preferences,
    });
    if (preferences.startHour >= preferences.endHour)
      throw new Error("Planning hours must end after they start.");
    const dates = Array.from({ length: dayCount }, (_, index) =>
      window.moment(startDate, "YYYY-MM-DD").add(index, "days"),
    );
    const byPath = Object.fromEntries(
      dates.map((day) => [
        this.options.daily.createDailyNotePath(day),
        day.format("YYYY-MM-DD"),
      ]),
    );
    const paths = [
      ...new Set([
        ...Object.keys(byPath),
        ...this.options.sourcePaths().slice(0, 24),
      ]),
    ];
    const current = await this.readDocuments(paths);
    const documents = Object.fromEntries(
      paths.map((path) => [
        path,
        { date: byPath[path] ?? null, text: current[path] ?? null },
      ]),
    );
    const linked = new Set(
      Object.entries(documents).flatMap(([path, document]) =>
        parseCaptureCandidates(path, document.text ?? "").flatMap((task) => {
          const link = taskLinkIdentity(task.raw);
          return link ? [link.taskId] : [];
        }),
      ),
    );
    const snapshot = get(this.options.tasks.state).snapshot;
    return buildPlanningContext({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      timezone: DateTime.local().zoneName,
      startDate,
      dayCount,
      request: request.request ?? "",
      preferences,
      documents,
      providerTasks: this.providerTasks(linked),
      commitments: await this.calendarCommitments(startDate, dayCount),
      identities: this.options.calendar.identitySnapshot(),
      settings: this.options.settings(),
      tasksUpdatedAt: snapshot?.fetchedAt,
    });
  }

  private validateProviderSources(draft: PlanningDraft, selectedIds: string[]) {
    const selected = new Set(selectedIds);
    const snapshot = get(this.options.tasks.state).snapshot;
    for (const action of draft.proposal.actions.filter((item) =>
      selected.has(item.id),
    )) {
      const source = draft.context.tasks.find(
        (task) => task.ref === action.sourceRef,
      );
      if (source?.kind !== "todoist") continue;
      const task = snapshot?.tasks.find((item) => item.id === source.taskId);
      if (
        !task ||
        task.completed ||
        snapshot?.account.id !== source.accountId ||
        snapshot?.provider !== source.provider ||
        JSON.stringify(task) !== source.fingerprint ||
        this.options.scheduler()?.plainCachedTask(task.id).raw !== source.raw
      )
        throw new PlanningValidationError([
          {
            actionId: action.id,
            code: "stale",
            message:
              "This Todoist task changed or completed. Refresh the planning context.",
          },
        ]);
    }
  }

  async apply(
    draft: PlanningDraft,
    selectedIds: string[],
    prepared: PlanningReceipt | null,
    onPrepared: (receipt: PlanningReceipt) => Promise<void>,
  ): Promise<PlanningReceipt> {
    const paths = Object.keys(draft.context.documents);
    return this.options.calendar.editNotes(
      async (notes, scanned) => {
        if (prepared) {
          const current = await this.readDocuments(
            prepared.batch.edits.map((edit) => edit.path),
          );
          if (
            prepared.batch.edits.every(
              (edit) => current[edit.path] === edit.after,
            )
          )
            return prepared;
          await notes.applyEdits(
            prepared.batch.edits.map((edit) => ({
              ...edit,
              before: edit.before ?? prepared.createdTemplates[edit.path] ?? "",
            })),
            prepared.batch.identities,
          );
          return prepared;
        }
        this.validateProviderSources(draft, selectedIds);
        const context: PlanningContext = {
          ...draft.context,
          commitments: await this.calendarCommitments(
            draft.context.startDate,
            draft.context.dayCount,
          ),
          blocks: draft.context.blocks.map((block) => ({
            ...block,
            uid:
              scanned.find(
                (item) =>
                  item.path === block.path &&
                  item.raw === block.raw &&
                  item.from === block.from,
              )?.uid ?? block.uid,
          })),
        };
        const current = await this.readDocuments(paths);
        const issues = validateProposal(
          context,
          draft.proposal,
          selectedIds,
          current,
        );
        if (issues.length) throw new PlanningValidationError(issues);
        const templates: Record<string, string> = {};
        const newUids = Object.fromEntries(
          selectedIds.map((id): [string, string] => [
            id,
            crypto.randomUUID().replace(/-/g, ""),
          ]),
        );
        const preview = buildPlanningBatch(
          context,
          draft.proposal,
          selectedIds,
          {
            settings: this.options.settings(),
            currentDocuments: current,
            templates: Object.fromEntries(
              Object.entries(context.documents)
                .filter(([, document]) => document.text === null)
                .map(([path]) => [path, ""]),
            ),
            newUids,
          },
        );
        let receipt: PlanningReceipt | undefined;
        try {
          for (const edit of preview.edits.filter(
            (item) => item.before === null,
          )) {
            const date = context.documents[edit.path]?.date;
            if (!date)
              throw new Error("The destination daily note is unavailable.");
            const file = await this.options.daily.createDailyNoteIfNeeded(
              window.moment(date, "YYYY-MM-DD"),
            );
            if (file.path !== edit.path)
              throw new Error(
                "Daily-note settings changed. Refresh the planning context.",
              );
            templates[edit.path] =
              await this.options.plugin.app.vault.read(file);
          }
          const batch = buildPlanningBatch(
            context,
            draft.proposal,
            selectedIds,
            {
              settings: this.options.settings(),
              currentDocuments: current,
              templates,
              newUids,
            },
          );
          const original = notes.identitySnapshot();
          const identityPatchBefore = Object.fromEntries(
            Object.keys(batch.identities).map(
              (uid): [string, LocalIdentity | null] => [
                uid,
                original[uid] ?? null,
              ],
            ),
          );
          receipt = {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            phase: "prepared",
            contextBefore: context,
            batch,
            identityPatchBefore,
            createdTemplates: templates,
          };
          await onPrepared(receipt);
          const settle = batch.edits.map((edit) =>
            this.options.preview.begin(edit.path, edit.after),
          );
          try {
            await notes.applyEdits(
              batch.edits.map((edit) => ({
                ...edit,
                before: edit.before ?? templates[edit.path] ?? "",
              })),
              batch.identities,
            );
            settle.forEach((finish) => finish(true));
          } catch (error) {
            settle.forEach((finish) => finish(false));
            throw error;
          }
          return receipt;
        } catch (error) {
          if (!receipt) await this.removeCreatedNotes(templates);
          throw error;
        }
      },
      () => this.flush(paths),
    );
  }

  private async removeCreatedNotes(templates: Record<string, string>) {
    for (const [path, template] of Object.entries(templates)) {
      const file = this.options.plugin.app.vault.getFileByPath(path);
      if (
        file &&
        (await this.readDocument(path)) === template &&
        (await this.options.plugin.app.vault.read(file)) === template
      )
        await this.options.plugin.app.vault.delete(file);
    }
  }

  async undo(receipt: PlanningReceipt, onNotesRestored: () => Promise<void>) {
    const paths = receipt.batch.edits.map((edit) => edit.path);
    await this.options.calendar.editNotes(
      async (notes, _blocks, scope) => {
        const current = await this.readDocuments(paths);
        const restored = receipt.batch.edits.every(
          (edit) =>
            current[edit.path] ===
              (edit.before ?? receipt.createdTemplates[edit.path]) ||
            (edit.before === null && current[edit.path] === null),
        );
        if (receipt.phase !== "cleanup" && !restored) {
          if (
            receipt.batch.edits.some(
              (edit) => current[edit.path] !== edit.after,
            )
          )
            throw new PlanningUndoBlockedError(
              "A note changed after this plan was applied. Review it before Undo.",
            );
          const reverse = receipt.batch.edits.map((edit) => ({
            path: edit.path,
            before: edit.after,
            after: edit.before ?? receipt.createdTemplates[edit.path] ?? "",
          }));
          const settle = reverse.map((edit) =>
            this.options.preview.begin(edit.path, edit.after),
          );
          try {
            await notes.applyEdits(reverse, receipt.identityPatchBefore);
            settle.forEach((finish) => finish(true));
          } catch (error) {
            settle.forEach((finish) => finish(false));
            throw error;
          }
        }
        await onNotesRestored();
        for (const uid of receipt.batch.createdUids) {
          if (!this.options.calendar.projectionNeedsCleanup(uid)) continue;
          const identity = receipt.batch.identities[uid]!;
          await scope.removeProjection(uid, identity.snapshot, identity.path);
        }
        await this.removeCreatedNotes(receipt.createdTemplates);
      },
      () => this.flush(paths),
    );
  }

  setUndoHold(held: boolean) {
    this.options.calendar.setPlanningUndoHold(held);
  }
}
