import * as Popover from "@radix-ui/react-popover";
import { useForm, useStore } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
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
  const rename = useMutation({
    mutationFn: async (title: string) => {
      const response = await props.request(
        `conversations/${encodeURIComponent(props.item.conversationId)}/title`,
        JSON.stringify({ title, expectedRevision: props.item.titleRevision ?? 0 }),
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.reason ?? result.error ?? "Cannot rename conversation");
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
      if (measureConversationTitle(value.title).valid)
        await rename.mutateAsync(value.title).catch(() => {});
    },
  });
  const measured = useStore(form.store, (state) => measureConversationTitle(state.values.title));
  return (
    <form
      className="settings-form title-form"
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <label htmlFor={labelId}>Conversation title</label>
      <form.Field name="title">
        {(field) => (
          <input
            id={labelId}
            value={field.state.value}
            onChange={(event) => field.handleChange(event.target.value)}
            onBlur={field.handleBlur}
            aria-invalid={!measured.valid}
            aria-describedby={`${labelId}-count`}
          />
        )}
      </form.Field>
      <p id={`${labelId}-count`} className={measured.valid ? "title-count" : "settings-error"}>
        {measured.wordCount} / 7 words · {measured.characters} / 128 characters
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
        <Button type="submit" disabled={!measured.valid || rename.isPending}>
          {rename.isPending ? "Saving…" : "Save title"}
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
