import * as Popover from "@radix-ui/react-popover";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { ARTIFACT_TITLE_MAX, isArtifactTitle } from "../../protocol/artifact-title.js";
import { measureConversationTitle } from "../../protocol/conversation-title.js";
import type { ListedConversation } from "../../protocol/conversations.js";
import { PencilDuotone } from "./icons.js";
import { SettingsPopover } from "./settings-popover.js";
import { Button } from "./ui/button.js";

function TitleForm(props: {
  readonly item: ListedConversation;
  readonly request: (path: string, body?: string) => Promise<Response>;
  readonly onSaved: () => void;
}) {
  const labelId = useId();
  const client = useQueryClient();
  const artifactId = props.item.artifactId;
  const rename = useMutation({
    mutationFn: async (title: string) => {
      const response = await props.request(
        artifactId === undefined
          ? `conversations/${encodeURIComponent(props.item.conversationId)}/title`
          : `conversations/${encodeURIComponent(props.item.conversationId)}/artifacts/${encodeURIComponent(artifactId)}/meta`,
        JSON.stringify(
          artifactId === undefined
            ? { title, expectedRevision: props.item.titleRevision ?? 0 }
            : { title },
        ),
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.reason ?? result.error ?? "Cannot save name");
    },
    onError: async () => {
      await client.invalidateQueries({ queryKey: ["conversations"] });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["conversations"] });
      props.onSaved();
    },
  });
  const form = useForm({
    defaultValues: { title: props.item.title },
    onSubmit: async ({ value }) => {
      const title = value.title.trim();
      if (artifactId === undefined ? measureConversationTitle(title).valid : isArtifactTitle(title))
        await rename.mutateAsync(title).catch(() => {});
    },
  });
  const measured = useStore(form.store, (state) => measureConversationTitle(state.values.title));
  const artifactTitle = useStore(form.store, (state) => state.values.title.trim());
  const valid = artifactId === undefined ? measured.valid : isArtifactTitle(artifactTitle);
  return (
    <form
      className="settings-form title-form"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <label htmlFor={labelId}>Artifact name</label>
      <form.Field name="title">
        {(field) => (
          <input
            id={labelId}
            value={field.state.value}
            onChange={(event) => field.handleChange(event.target.value)}
            onBlur={field.handleBlur}
            aria-invalid={!valid}
            aria-describedby={`${labelId}-count`}
          />
        )}
      </form.Field>
      <p id={`${labelId}-count`} className={valid ? "title-count" : "settings-error"}>
        {artifactId === undefined
          ? `${measured.wordCount} / 7 words · ${measured.characters} / 128 characters`
          : `${artifactTitle.length} / ${ARTIFACT_TITLE_MAX} characters`}
      </p>
      {rename.error ? (
        <p role="alert" className="settings-error">
          {rename.error.message} Close and reopen to load the current title.
        </p>
      ) : null}
      <div className="title-actions">
        <Popover.Close asChild>
          <Button variant="ghost">Cancel</Button>
        </Popover.Close>
        <Button type="submit" disabled={!valid || rename.isPending}>
          {rename.isPending ? "Saving…" : artifactId === undefined ? "Save title" : "Save name"}
        </Button>
      </div>
    </form>
  );
}
export function ConversationRename(props: {
  readonly item: ListedConversation;
  readonly request: (path: string, body?: string) => Promise<Response>;
}) {
  const [open, setOpen] = useState(false);
  // Opening captures the revision. Polls must not silently update a form's compare-and-replace token.
  const [editing, setEditing] = useState(props.item);
  return (
    <SettingsPopover
      label={`Rename ${props.item.title}`}
      trigger={<PencilDuotone size={16} />}
      triggerClassName="hub-rename"
      className="title-popover"
      side="bottom"
      open={open}
      onOpenChange={(value) => {
        if (value) setEditing(props.item);
        setOpen(value);
      }}
    >
      <TitleForm item={editing} request={props.request} onSaved={() => setOpen(false)} />
    </SettingsPopover>
  );
}
