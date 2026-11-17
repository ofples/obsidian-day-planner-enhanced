import { Modal, type App } from "obsidian";

import type { DayPlannerSettings } from "../settings";

import type { GoogleCalendarSettings, GoogleCalendarSync } from "./service";
import type { GoogleCalendarInfo } from "./types";
import { visibleGoogleCalendars } from "./view";

export function calendarDisplayName(calendar: GoogleCalendarInfo) {
  return calendar.summaryOverride || calendar.summary || calendar.id;
}

export function syncCalendarUnavailableReason(
  calendar: GoogleCalendarInfo,
  boundCalendarId = "",
  taskFeedIds: string[] = [],
) {
  if (!["owner", "writer"].includes(calendar.accessRole ?? ""))
    return "Read-only";
  if (taskFeedIds.includes(calendar.id)) return "Used by a task calendar feed";
  if (boundCalendarId && calendar.id !== boundCalendarId)
    return "Schedule links use another calendar";
  return "";
}

interface CalendarPickerOptions {
  mode: "sync" | "display";
  settings(): DayPlannerSettings;
  service(): GoogleCalendarSync;
  update(patch: Partial<GoogleCalendarSettings>): void;
  openConnections(): void;
  onApplied?(): void;
}

/** One calendar-list UI for a single sync destination and multiple display calendars. */
export class GoogleCalendarPicker extends Modal {
  private generation = 0;
  private readonly radioGroup = `planner-calendar-${crypto.randomUUID()}`;
  private calendars: GoogleCalendarInfo[] = [];
  private selected = new Set<string>();
  private googleSelection = false;
  private query = "";
  private list?: HTMLElement;
  private saveButton?: HTMLButtonElement;

  constructor(
    app: App,
    private readonly options: CalendarPickerOptions,
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.classList.add("planner-calendar-picker");
    this.titleEl.textContent =
      this.options.mode === "sync"
        ? "Choose sync calendar"
        : "Calendars shown in the planner";
    void this.load();
  }

  private async load() {
    const generation = ++this.generation;
    this.contentEl.textContent = "Loading calendars…";
    try {
      if (!this.options.service().isConnected())
        throw new Error("Sign in to Google Calendar through Connections.");
      const calendars = await this.options.service().calendars();
      if (generation !== this.generation) return;
      this.calendars = calendars.filter((calendar) => !calendar.deleted);
      const settings = this.options.settings().googleCalendar;
      this.googleSelection =
        this.options.mode === "display" && settings.visibleCalendarIds === null;
      this.selected =
        this.options.mode === "sync"
          ? new Set(
              [
                this.options.service().boundCalendarId ||
                  (settings.calendarId === "primary"
                    ? this.calendars.find((calendar) => calendar.primary)?.id
                    : settings.calendarId),
              ].filter((id): id is string => !!id),
            )
          : new Set(
              visibleGoogleCalendars(this.calendars, settings).map(
                (calendar) => calendar.id,
              ),
            );
      this.calendars.sort((left, right) => {
        const selectedFirst =
          Number(this.selected.has(right.id)) -
          Number(this.selected.has(left.id));
        const editableFirst =
          Number(!!this.unavailable(left)) - Number(!!this.unavailable(right));
        return (
          selectedFirst ||
          editableFirst ||
          calendarDisplayName(left).localeCompare(calendarDisplayName(right))
        );
      });
      this.render();
    } catch (error) {
      if (generation !== this.generation) return;
      this.contentEl.textContent =
        error instanceof Error ? error.message : "Could not load calendars.";
      const action = this.contentEl.ownerDocument.createElement("button");
      action.textContent = this.options.service().isConnected()
        ? "Retry"
        : "Open Connections";
      action.addEventListener("click", () => {
        if (this.options.service().isConnected()) void this.load();
        else {
          this.close();
          this.options.openConnections();
        }
      });
      this.contentEl.append(action);
    }
  }

  private render() {
    const doc = this.contentEl.ownerDocument;
    this.contentEl.replaceChildren();
    const intro = doc.createElement("p");
    intro.className = "planner-calendar-picker-intro";
    intro.textContent =
      this.options.mode === "sync"
        ? "Daily-note schedules sync with one editable calendar."
        : "Choose the calendars to display in your planner.";
    this.contentEl.append(intro);
    const search = doc.createElement("input");
    search.type = "search";
    search.placeholder = "Search calendars";
    search.setAttribute("aria-label", "Search calendars");
    search.className = "planner-calendar-search";
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      this.renderList();
    });
    this.contentEl.append(search);
    if (this.options.mode === "display") {
      const follow = doc.createElement("label");
      follow.className = "planner-calendar-follow";
      const input = doc.createElement("input");
      input.type = "checkbox";
      input.checked = this.googleSelection;
      input.addEventListener("change", () => {
        this.googleSelection = input.checked;
        if (this.googleSelection)
          this.selected = new Set(
            visibleGoogleCalendars(this.calendars, {
              ...this.options.settings().googleCalendar,
              visibleCalendarIds: null,
            }).map((calendar) => calendar.id),
          );
        this.renderList();
      });
      follow.append(
        input,
        doc.createTextNode("Follow Google Calendar selection"),
      );
      this.contentEl.append(follow);
    }
    const bound = this.options.service().boundCalendarId;
    if (this.options.mode === "sync" && bound) {
      const note = doc.createElement("p");
      note.className = "planner-calendar-picker-hint";
      note.textContent = this.calendars.some(
        (calendar) => calendar.id === bound,
      )
        ? "Schedule links for this vault use the calendar marked below."
        : "The linked sync calendar is unavailable in this account. Check access through Connections.";
      this.contentEl.append(note);
    }
    this.list = doc.createElement("div");
    this.list.className = "planner-calendar-list";
    this.contentEl.append(this.list);
    const buttons = doc.createElement("div");
    buttons.className = "planner-calendar-picker-buttons";
    const cancel = doc.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());
    this.saveButton = doc.createElement("button");
    this.saveButton.className = "mod-cta";
    this.saveButton.textContent =
      this.options.mode === "sync" ? "Use calendar" : "Apply";
    this.saveButton.addEventListener("click", () => this.apply());
    buttons.append(cancel, this.saveButton);
    this.contentEl.append(buttons);
    this.renderList();
  }

  private unavailable(calendar: GoogleCalendarInfo) {
    if (this.options.mode !== "sync") return "";
    const feeds = Object.values(
      this.options.settings().taskCapture.accounts,
    ).flatMap((account) => account.calendarDisplay?.googleCalendarIds ?? []);
    return syncCalendarUnavailableReason(
      calendar,
      this.options.service().boundCalendarId,
      feeds,
    );
  }

  private renderList() {
    if (!this.list) return;
    this.list.replaceChildren();
    const doc = this.list.ownerDocument;
    const calendars = this.calendars.filter((calendar) =>
      calendarDisplayName(calendar)
        .toLocaleLowerCase()
        .includes(this.query.trim().toLocaleLowerCase()),
    );
    const group = this.radioGroup;
    for (const calendar of calendars) {
      const reason = this.unavailable(calendar);
      const row = doc.createElement("label");
      row.className = "planner-calendar-row";
      row.classList.toggle("is-disabled", !!reason);
      const input = doc.createElement("input");
      input.type = this.options.mode === "sync" ? "radio" : "checkbox";
      input.name = group;
      input.value = calendar.id;
      input.checked = this.selected.has(calendar.id);
      input.disabled = !!reason || this.googleSelection;
      input.addEventListener("change", () => {
        if (this.options.mode === "sync")
          this.selected = new Set([calendar.id]);
        else if (input.checked) this.selected.add(calendar.id);
        else this.selected.delete(calendar.id);
        this.updateSaveButton();
      });
      const swatch = doc.createElement("span");
      swatch.className = "planner-calendar-color";
      swatch.style.backgroundColor =
        calendar.backgroundColor ?? "var(--text-muted)";
      swatch.setAttribute("aria-hidden", "true");
      const text = doc.createElement("span");
      text.className = "planner-calendar-name";
      text.textContent = calendarDisplayName(calendar);
      const access = doc.createElement("small");
      access.textContent =
        reason ||
        (this.options.mode === "sync" &&
        this.options.service().boundCalendarId === calendar.id
          ? "Linked to this vault"
          : calendar.primary
            ? "Primary"
            : "");
      row.append(input, swatch, text);
      if (access.textContent) row.append(access);
      this.list.append(row);
    }
    if (!calendars.length)
      this.list.textContent = this.calendars.length
        ? "No matching calendars."
        : "No calendars available.";
    this.updateSaveButton();
  }

  private updateSaveButton() {
    if (this.saveButton)
      this.saveButton.disabled =
        this.options.mode === "sync" &&
        !this.calendars.some(
          (calendar) =>
            this.selected.has(calendar.id) && !this.unavailable(calendar),
        );
  }

  private apply() {
    if (!this.options.service().isConnected()) {
      this.contentEl.textContent =
        "Sign in to Google Calendar through Connections.";
      return;
    }
    if (this.options.mode === "sync") {
      const calendar = this.calendars.find(
        (calendar) =>
          this.selected.has(calendar.id) && !this.unavailable(calendar),
      );
      if (!calendar) return;
      if (this.options.settings().googleCalendar.calendarId !== calendar.id)
        this.options.update({ calendarId: calendar.id });
    } else
      this.options.update({
        visibleCalendarIds: this.googleSelection ? null : [...this.selected],
      });
    this.options.onApplied?.();
    this.close();
  }

  onClose() {
    this.generation++;
    this.contentEl.replaceChildren();
  }
}
