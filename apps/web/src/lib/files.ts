/**
 * The image files carried by a paste or a drop, ignoring anything else.
 *
 * Pastes arrive as items, while a drop may populate either or both collections
 * depending on where the drag came from, so both are read and deduplicated.
 */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];

  const files: File[] = [];
  const add = (file: File | null | undefined): void => {
    if (!file || files.includes(file)) return;
    // An empty type happens on a few platforms; the server has the last word.
    if (file.type !== '' && !file.type.startsWith('image/')) return;
    files.push(file);
  };

  for (let index = 0; index < data.items.length; index++) {
    const item = data.items[index];
    if (item?.kind === 'file') add(item.getAsFile());
  }
  for (let index = 0; index < data.files.length; index++) {
    add(data.files[index] ?? null);
  }

  return files;
}

/** Whether a drag is carrying files at all, as opposed to text or a selection. */
export function dragHasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') ?? false;
}
