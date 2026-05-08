import * as assert from 'assert';
import { PresenceTreeProvider } from '../../ui/PresenceTreeProvider.js';
import type { PresenceInfo } from '../../types/chat.js';

suite('PresenceTreeProvider', () => {
  let provider: PresenceTreeProvider;

  setup(() => {
    provider = new PresenceTreeProvider();
  });

  const info = (
    id: string,
    name: string,
    branch = 'main',
    file: string | null = null,
  ): PresenceInfo => ({
    memberId: id,
    displayName: name,
    branch,
    activeFilePath: file,
    lastUpdated: 0,
  });

  test('upsert + getEntries returns one entry', () => {
    provider.upsert(info('m1', 'Alice'));
    assert.strictEqual(provider.getEntries().length, 1);
  });

  test('removeMember removes entry', () => {
    provider.upsert(info('m1', 'Alice'));
    provider.upsert(info('m2', 'Bob'));
    provider.removeMember('m1');
    assert.strictEqual(provider.getEntries().length, 1);
    assert.strictEqual(provider.getEntries()[0].memberId, 'm2');
  });

  test('clear empties the map', () => {
    provider.upsert(info('m1', 'Alice'));
    provider.upsert(info('m2', 'Bob'));
    provider.clear();
    assert.strictEqual(provider.getEntries().length, 0);
  });

  test('getChildren sorts self first, others alphabetical', async () => {
    provider.upsert(info('zoe-id', 'Zoe'));
    provider.upsert(info('alice-id', 'Alice'));
    provider.upsert(info('bob-id', 'Bob'));
    provider.setSelfMemberId('zoe-id');
    const children = await provider.getChildren();
    assert.deepStrictEqual(
      children.map(c => c.displayName),
      ['Zoe', 'Alice', 'Bob'],
    );
  });

  test('getChildren without selfMemberId sorts purely alphabetical', async () => {
    provider.upsert(info('m3', 'Charlie'));
    provider.upsert(info('m1', 'Alice'));
    provider.upsert(info('m2', 'Bob'));
    const children = await provider.getChildren();
    assert.deepStrictEqual(
      children.map(c => c.displayName),
      ['Alice', 'Bob', 'Charlie'],
    );
  });

  test('getTreeItem appends "(you)" to self row description only', () => {
    provider.upsert(info('me', 'Me', 'main', 'src/foo.ts'));
    provider.upsert(info('them', 'Them', 'main', 'src/bar.ts'));
    provider.setSelfMemberId('me');
    const selfItem = provider.getTreeItem(provider.getEntries().find(e => e.memberId === 'me')!);
    const otherItem = provider.getTreeItem(provider.getEntries().find(e => e.memberId === 'them')!);
    assert.match(String(selfItem.description), /\(you\)/);
    assert.doesNotMatch(String(otherItem.description), /\(you\)/);
  });

  test('description uses basename of activeFilePath', () => {
    provider.upsert(info('m1', 'Alice', 'main', 'src/deep/path/foo.ts'));
    const item = provider.getTreeItem(provider.getEntries()[0]);
    assert.match(String(item.description), /foo\.ts/);
  });

  test('description shows "(no file)" when activeFilePath is null', () => {
    provider.upsert(info('m1', 'Alice', 'main', null));
    const item = provider.getTreeItem(provider.getEntries()[0]);
    assert.match(String(item.description), /\(no file\)/);
  });

  test('git-compare prefix when row branch != currentBranch', () => {
    provider.upsert(info('m1', 'Alice', 'feature-x', 'src/foo.ts'));
    provider.setCurrentBranch('main');
    const item = provider.getTreeItem(provider.getEntries()[0]);
    assert.match(String(item.description), /git-compare/);
    assert.match(String(item.description), /feature-x/);
  });

  test('no git-compare prefix when branch matches currentBranch', () => {
    provider.upsert(info('m1', 'Alice', 'main', 'src/foo.ts'));
    provider.setCurrentBranch('main');
    const item = provider.getTreeItem(provider.getEntries()[0]);
    assert.doesNotMatch(String(item.description), /git-compare/);
  });

  test('tooltip format: "On branch: {branch}\\nFile: {path}"', () => {
    provider.upsert(info('m1', 'Alice', 'main', 'src/foo.ts'));
    const item = provider.getTreeItem(provider.getEntries()[0]);
    assert.strictEqual(item.tooltip, 'On branch: main\nFile: src/foo.ts');
  });

  test('contextValue is presenceMember-self for self row', () => {
    provider.upsert(info('me', 'Me'));
    provider.setSelfMemberId('me');
    const item = provider.getTreeItem(provider.getEntries()[0]);
    assert.strictEqual(item.contextValue, 'presenceMember-self');
  });

  test('contextValue is presenceMember-other for non-self row', () => {
    provider.upsert(info('other', 'Other'));
    const item = provider.getTreeItem(provider.getEntries()[0]);
    assert.strictEqual(item.contextValue, 'presenceMember-other');
  });
});
