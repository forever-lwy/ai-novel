import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LocationPanel } from '../client/WorldPanel';
import type { Entity, Fact, Relation } from '../shared/types';

const entity = (id: string, kind: Entity['kind'], name: string, facts: Fact[] = []): Entity => ({ id, kind, name, facts, aliases: [], description: '', visibility: 'public', locked: false });
const location = (id: string, text: string, temporal: Fact['temporal'] = 'current'): Fact => ({ id, text, attribute: 'location', temporal, certainty: 'fact', visibility: 'public' });
const relation = (id: string, fromId: string, toId: string, label: string): Relation => ({ id, fromId, toId, label, visibility: 'public' });
const render = (entities: Entity[], relations: Relation[] = []) => renderToStaticMarkup(createElement(LocationPanel, { entities, relations, onCitation: () => {} }));
const graph = (html: string) => html.match(/<svg[^>]*role="img"[^>]*>[\s\S]*?<\/svg>/)![0];
function point(html: string, id: string) {
  const match = html.match(new RegExp(`data-location-id="${id}"><title>[^<]*<\\/title><circle cx="([^"]+)" cy="([^"]+)"`))!;
  return { x: Number(match[1]), y: Number(match[2]) };
}

describe('world geography and versioned character positions', () => {
  it('keeps people, events and task links out of the geography while showing the current position separately', () => {
    const html = render([
      entity('person', 'character', '琥珀', [location('old', '曾在旧城', 'past'), location('now', '现在位于森林')]),
      entity('west', 'location', '西城'), entity('forest', 'location', '森林'), entity('task', 'event', '寻找失踪者'),
    ], [relation('geography', 'forest', 'west', '位于西城以东'), relation('person-location', 'person', 'forest', '身处'), relation('task-location', 'task', 'west', '任务地点'), relation('event-route', 'forest', 'west', '调查任务位于')]);
    const svg = graph(html);
    expect(svg).toContain('西城'); expect(svg).toContain('森林');
    expect(svg).not.toContain('琥珀'); expect(svg).not.toContain('寻找失踪者'); expect(svg).not.toContain('调查任务');
    expect(point(svg, 'forest').x).toBeGreaterThan(point(svg, 'west').x);
    expect(html).toContain('现在位于森林'); expect(html).not.toContain('曾在旧城');
  });

  it('renders the position from each supplied story snapshot and never guesses among multiple current locations', () => {
    const newer = render([entity('person', 'character', '琥珀', [location('first', '第一章位于旧城', 'past'), location('second', '第二章位于森林')])]);
    const earlier = render([entity('person', 'character', '琥珀', [location('first', '第一章位于旧城')])]);
    const conflicting = render([entity('person', 'character', '琥珀', [location('first', '位于旧城'), location('second', '位于森林')])]);
    expect(newer).toContain('第二章位于森林'); expect(newer).not.toContain('第一章位于旧城');
    expect(earlier).toContain('第一章位于旧城'); expect(earlier).not.toContain('第二章位于森林');
    expect(conflicting).toContain('位置记录存在冲突，待确认');
    expect(conflicting).not.toContain('位于旧城'); expect(conflicting).not.toContain('位于森林');
  });

  it('wraps disconnected places into rows and preserves directions within connected groups', () => {
    const places = Array.from({ length: 20 }, (_, index) => entity(`place-${index}`, 'location', `地点${index + 1}`));
    const svg = graph(render(places, [relation('east', 'place-1', 'place-0', '位于以东'), relation('north', 'place-3', 'place-2', '位于北侧')]));
    const viewBox = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)!;
    expect(Number(viewBox[1])).toBeLessThanOrEqual(800);
    expect(Number(viewBox[2])).toBeGreaterThan(240);
    expect(point(svg, 'place-1').x).toBeGreaterThan(point(svg, 'place-0').x);
    expect(point(svg, 'place-3').y).toBeLessThan(point(svg, 'place-2').y);
    expect(new Set(places.map(place => point(svg, place.id).y)).size).toBeGreaterThan(2);
    expect(svg).toContain(`style="width:${Number(viewBox[1])}px"`);
  });
});
