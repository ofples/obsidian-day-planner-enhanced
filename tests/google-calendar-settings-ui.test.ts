import { expect, test, vi } from "vitest";

vi.mock("obsidian", () => ({
  Modal: class {},
  Setting: class {
    constructor(readonly container: HTMLElement) {}
    setName(value: string) {
      this.container.append(document.createTextNode(value));
      return this;
    }
    setDesc(_value: string) {
      return this;
    }
    addText(callback: (control: unknown) => void) {
      const input = document.createElement("input");
      this.container.append(input);
      const control = {
        inputEl: input,
        setValue(value: string) {
          input.value = value;
          return control;
        },
        onChange(handler: (value: string) => void) {
          input.addEventListener("change", () => handler(input.value));
          return control;
        },
      };
      callback(control);
      return this;
    }
    addButton(callback: (control: unknown) => void) {
      const button = document.createElement("button");
      this.container.append(button);
      const control = {
        setButtonText(value: string) {
          button.textContent = value;
          return control;
        },
        onClick(handler: () => void) {
          button.addEventListener("click", handler);
          return control;
        },
      };
      callback(control);
      return this;
    }
    addDropdown(callback: (control: unknown) => void) {
      const select = document.createElement("select");
      this.container.append(select);
      const control = {
        addOptions(options: Record<string, string>) {
          for (const [value, label] of Object.entries(options))
            select.add(new Option(label, value));
          return control;
        },
        setValue(value: string) {
          select.value = value;
          return control;
        },
        onChange(handler: (value: string) => void) {
          select.addEventListener("change", () => handler(select.value));
          return control;
        },
      };
      callback(control);
      return this;
    }
  },
}));

import { googleCalendarSettingDefinitions } from "../src/google-calendar/settings-ui";
import { defaultSettingsForTests } from "../src/settings";
import type { GoogleCalendarSync } from "../src/google-calendar/service";
import type { App, Setting } from "obsidian";

test("advanced OAuth and color settings are collapsed and retain editable values", () => {
  const settings = structuredClone(defaultSettingsForTests);
  settings.googleCalendar.clientId = "existing.apps.googleusercontent.com";
  settings.colorOverrides = [
    { text: "#work", color: "#123456", darkModeColor: "#654321" },
  ];
  const update = vi.fn(),
    setClientSecret = vi.fn();
  const group = googleCalendarSettingDefinitions(
    () => settings,
    update,
    () => ({ setClientSecret }) as unknown as GoogleCalendarSync,
    {} as App,
  );
  const render = (name: string) => {
    const item = group.items?.find((value) => value.name === name);
    if (!item || !("render" in item) || !item.render)
      throw new Error(`Missing ${name}`);
    const descEl = document.createElement("div");
    item.render({ descEl } as unknown as Setting, {} as never);
    return descEl.querySelector("details")!;
  };
  const oauth = render("Advanced Google connection");
  expect(oauth.open).toBe(false);
  const inputs = oauth.querySelectorAll("input");
  expect(inputs[0]?.value).toBe("existing.apps.googleusercontent.com");
  inputs[0]!.value = "replacement.apps.googleusercontent.com";
  inputs[0]!.dispatchEvent(new Event("change"));
  expect(update).toHaveBeenCalledWith({
    clientId: "replacement.apps.googleusercontent.com",
  });
  inputs[1]!.value = "new-secret";
  inputs[1]!.dispatchEvent(new Event("change"));
  oauth.querySelector("button")!.click();
  expect(setClientSecret).toHaveBeenCalledWith("new-secret");
  const colors = render("Google event colors");
  expect(colors.open).toBe(false);
  expect(colors.textContent).toContain("#work");
  expect(colors.querySelectorAll("select")).toHaveLength(2);
  const mapping = colors.querySelector("select")!;
  mapping.value = "1";
  mapping.dispatchEvent(new Event("change"));
  expect(update).toHaveBeenCalledWith({ colorMappings: { "#work": "1" } });
});
