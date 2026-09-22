/** Files carried by a paste event, in paste order. */
export const pastedFilesFromData = (data: DataTransfer | null): File[] => {
  if (!data) return [];
  if (data.files.length > 0) return Array.from(data.files);
  const out: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file !== null) out.push(file);
  }
  return out;
};
