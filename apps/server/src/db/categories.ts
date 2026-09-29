import type { DatabaseSync } from 'node:sqlite';
import type { Category } from '@harmony/shared';

export interface CategoryRow {
  id: string;
  name: string;
  position: number;
  required_role_id: string | null;
}

export function toCategory(row: CategoryRow): Category {
  return { id: row.id, name: row.name, position: row.position, requiredRoleId: row.required_role_id };
}

export function listCategories(sqlite: DatabaseSync): CategoryRow[] {
  return sqlite.prepare('SELECT * FROM categories ORDER BY position, name').all() as unknown as CategoryRow[];
}

export function findCategory(sqlite: DatabaseSync, id: string): CategoryRow | null {
  return (sqlite.prepare('SELECT * FROM categories WHERE id = ?').get(id) as CategoryRow | undefined) ?? null;
}

export function nextCategoryPosition(sqlite: DatabaseSync): number {
  const row = sqlite
    .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM categories')
    .get() as { position: number };
  return row.position;
}

export function insertCategory(
  sqlite: DatabaseSync,
  input: { id: string; name: string; position: number; requiredRoleId?: string | null },
): void {
  sqlite
    .prepare('INSERT INTO categories (id, name, position, required_role_id) VALUES (?, ?, ?, ?)')
    .run(input.id, input.name, input.position, input.requiredRoleId ?? null);
}

export function updateCategory(
  sqlite: DatabaseSync,
  id: string,
  patch: { name?: string; position?: number; requiredRoleId?: string | null },
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name);
  }
  if (patch.position !== undefined) {
    sets.push('position = ?');
    values.push(patch.position);
  }
  if (patch.requiredRoleId !== undefined) {
    sets.push('required_role_id = ?');
    values.push(patch.requiredRoleId);
  }
  if (sets.length === 0) return;

  values.push(id);
  sqlite.prepare(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteCategory(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare('DELETE FROM categories WHERE id = ?').run(id);
}

/** Swaps a category's position with its neighbour in the display order. */
export function moveCategory(sqlite: DatabaseSync, id: string, direction: 'up' | 'down'): void {
  const ordered = listCategories(sqlite);
  const index = ordered.findIndex((category) => category.id === id);
  const current = ordered[index];
  const neighbor = ordered[direction === 'up' ? index - 1 : index + 1];
  if (!current || !neighbor) return;

  sqlite.exec('BEGIN');
  try {
    sqlite.prepare('UPDATE categories SET position = ? WHERE id = ?').run(neighbor.position, current.id);
    sqlite.prepare('UPDATE categories SET position = ? WHERE id = ?').run(current.position, neighbor.id);
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    throw error;
  }
}
