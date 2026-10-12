import type { LibrarySession } from "../library/session";
import type { TrackMeta, TrackRef } from "../library/types";
import { formatTime, h } from "./dom";

const ALL = "all";

/** Services sidebar, crate list, search box and track table with pre-analysed BPM/key. */
export class LibraryView {
  readonly root: HTMLElement;
  private selected = ALL;
  private rows = new Map<string, HTMLTableRowElement>();
  private searchSeq = 0;
  private readonly services = h("ul.services");
  private readonly crates = h("ul.crates");
  private readonly search = h("input.search", {
    type: "search",
    placeholder: "Search · try  bpm:120-128  key:~8A  funk",
    "aria-label": "Search crates",
  }) as HTMLInputElement;
  private readonly tbody = h("tbody");
  private readonly note = h("div.lib-note", { role: "status" });

  constructor(
    private readonly session: LibrarySession,
    private readonly onLoad: (track: TrackRef, deck: "A" | "B") => void,
    private readonly onFiles: (files: FileList) => void,
  ) {
    const fileInput = h("input", { type: "file", accept: "audio/*", multiple: true, hidden: true }) as HTMLInputElement;
    fileInput.onchange = () => { if (fileInput.files?.length) this.onFiles(fileInput.files); fileInput.value = ""; };
    this.search.oninput = () => void this.refreshTable();

    this.root = h("section.library", { "aria-label": "Library" },
      h("aside.sidebar", {},
        h("h2", {}, "Services"),
        this.services,
        h("h2", {}, "Crates"),
        this.crates,
        h("div.sidebar-actions", {},
          h("button.small", { onclick: () => fileInput.click() }, "+ Add files"),
          this.newCrateForm(),
          fileInput,
        ),
      ),
      h("div.tracks", {},
        h("div.search-row", {}, this.search),
        this.note,
        h("div.table-wrap", {},
          h("table", {},
            h("thead", {}, h("tr", {}, ...["Title", "Artist", "BPM", "Key", "", "Time", "Source", ""].map((c) => h("th", {}, c)))),
            this.tbody,
          ),
        ),
      ),
    );

    session.on((e) => {
      if (e.type === "providers") this.renderServices();
      if (e.type === "crates") { this.renderCrates(); void this.refreshTable(); }
      if (e.type === "meta") this.updateMeta(e.trackId, e.meta);
    });
    this.renderServices();
    this.renderCrates();
  }

  /** Inline name field: embedded viewers block window.prompt(). */
  private newCrateForm(): HTMLFormElement {
    const input = h("input.crate-name", { id: "new-crate-name", type: "text", placeholder: "New crate name", "aria-label": "New crate name" }) as HTMLInputElement;
    const form = h("form.new-crate", {}, input, h("button.small", { type: "submit" }, "+ Crate")) as HTMLFormElement;
    form.onsubmit = (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (!name) return;
      input.value = "";
      this.select(this.session.createCrate(name).id);
    };
    return form;
  }

  private select(id: string): void {
    this.selected = id;
    this.renderCrates();
    void this.refreshTable();
  }

  private renderServices(): void {
    this.services.replaceChildren(...this.session.providerStates().map((s) => {
      const connected = s.status === "connected";
      const btn = h("button.small", {
        "data-testid": `connect-${s.provider.id}`,
        disabled: s.status === "connecting" || s.provider.kind === "local",
        onclick: () => void (connected ? this.session.disconnect(s.provider.id) : this.session.connect(s.provider.id)),
      }, s.provider.kind === "local" ? "on" : connected ? "Log out" : s.status === "connecting" ? "…" : "Log in");
      return h("li.service", { class: s.status, title: s.error ?? "" },
        h("span.dot"),
        h("span.service-name", {}, s.provider.name),
        btn,
        s.error ? h("div.service-error", {}, s.error) : null,
      );
    }));
  }

  private renderCrates(): void {
    const crates = this.session.crates();
    if (this.selected !== ALL && !crates.some((c) => c.id === this.selected)) this.selected = ALL;
    const item = (id: string, label: string, count?: number) => h("li", {},
      h("button.crate", { "aria-current": this.selected === id ? "true" : undefined, onclick: () => this.select(id) },
        label, count !== undefined ? h("span.count", {}, String(count)) : null));
    this.crates.replaceChildren(
      item(ALL, "All connected services"),
      ...crates.map((c) => item(c.id, `${c.providerId ? "◉ " : "▤ "}${c.name}`, c.trackIds.length)),
    );
  }

  private async refreshTable(): Promise<void> {
    const seq = ++this.searchSeq;
    const q = this.search.value;
    let tracks: TrackRef[];
    if (this.selected === ALL) {
      if (q.trim()) {
        const { results, failures } = await this.session.searchAll(q);
        if (seq !== this.searchSeq) return;
        tracks = results;
        this.note.textContent = failures.map((f) => `${f.providerId}: ${f.error}`).join(" · ");
      } else {
        tracks = this.session.crates().filter((c) => c.providerId).flatMap((c) => this.session.searchCrate(c.id, ""));
        this.note.textContent = "";
      }
    } else {
      tracks = this.session.searchCrate(this.selected, q);
      this.note.textContent = "";
    }
    if (seq !== this.searchSeq) return;
    this.rows.clear();
    this.tbody.replaceChildren(...tracks.map((t) => this.row(t)));
    if (!tracks.length) {
      this.tbody.append(h("tr", {}, h("td.empty", { colspan: 8 }, this.session.crates().length ? "No matching tracks" : "Log in to a service or add files to start")));
    }
  }

  private row(t: TrackRef): HTMLTableRowElement {
    const provider = this.session.providerStates().find((s) => s.provider.id === t.providerId)?.provider.name ?? t.providerId;
    const tr = h("tr", { "data-track": t.id },
      h("td.title", {}, t.title),
      h("td", {}, t.artist),
      h("td.num.bpm-cell", {}),
      h("td.key-cell", {}),
      h("td.camelot-cell", {}),
      h("td.num", {}, t.durationSec ? formatTime(t.durationSec).replace(/\.\d$/, "") : ""),
      h("td.source", {}, provider),
      h("td.load", {},
        h("button.small", { onclick: () => this.onLoad(t, "A"), "data-testid": "load-a" }, "A"),
        h("button.small", { onclick: () => this.onLoad(t, "B"), "data-testid": "load-b" }, "B"),
      ),
    ) as HTMLTableRowElement;
    this.rows.set(t.id, tr);
    this.fillMeta(tr, this.session.metaFor(t.id));
    return tr;
  }

  private updateMeta(trackId: string, meta: TrackMeta): void {
    const tr = this.rows.get(trackId);
    if (tr) this.fillMeta(tr, meta);
  }

  private fillMeta(tr: HTMLTableRowElement, meta: TrackMeta | undefined): void {
    const [bpm, key, camelot] = [".bpm-cell", ".key-cell", ".camelot-cell"].map((s) => tr.querySelector<HTMLElement>(s)!);
    if (meta?.summary) {
      bpm.textContent = meta.summary.bpm.toFixed(1) + (meta.summary.variableTempo ? "~" : "");
      bpm.title = meta.summary.variableTempo ? "Variable tempo (dominant segment shown)" : "";
      key.textContent = meta.summary.key;
      camelot.textContent = meta.summary.camelot;
      camelot.className = `camelot-cell camelot camelot-${meta.summary.camelot}`;
    } else {
      bpm.textContent = meta?.status === "error" ? "error" : meta ? "…" : "";
      bpm.title = meta?.error ?? "";
      key.textContent = "";
      camelot.textContent = "";
    }
  }
}
