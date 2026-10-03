import { describe, expect, it } from 'vitest';
import type { OpResult } from '../src/figma/catalogue.ts';
import { toDtcg, tokenSegment } from '../src/figma/tokens.ts';

type Raw = OpResult['variables'];

const RAW: Raw = {
  collections: [
    {
      id: 'VariableCollectionId:1:0',
      name: 'Primitives',
      defaultModeId: '1:0',
      modes: [{ modeId: '1:0', name: 'Value' }],
    },
    {
      id: 'VariableCollectionId:2:0',
      name: 'Theme',
      defaultModeId: '2:0',
      modes: [
        { modeId: '2:0', name: 'Light' },
        { modeId: '2:1', name: 'Dark' },
      ],
    },
  ],
  variables: [
    {
      id: 'VariableID:1:1',
      name: 'blue/500',
      collectionId: 'VariableCollectionId:1:0',
      type: 'COLOR',
      scopes: ['ALL_SCOPES'],
      values: { '1:0': { r: 0.2, g: 0.4, b: 1, a: 1 } },
    },
    {
      id: 'VariableID:1:2',
      name: 'space/1.5',
      collectionId: 'VariableCollectionId:1:0',
      type: 'FLOAT',
      scopes: ['GAP', 'WIDTH_HEIGHT'],
      values: { '1:0': 12 },
      description: 'Small gap',
    },
    {
      id: 'VariableID:1:3',
      name: 'weight/bold',
      collectionId: 'VariableCollectionId:1:0',
      type: 'FLOAT',
      scopes: ['FONT_WEIGHT'],
      values: { '1:0': 700 },
    },
    {
      id: 'VariableID:1:4',
      name: 'opacity/muted',
      collectionId: 'VariableCollectionId:1:0',
      type: 'FLOAT',
      scopes: ['ALL_SCOPES'],
      values: { '1:0': 0.6 },
    },
    {
      id: 'VariableID:1:5',
      name: 'font/body',
      collectionId: 'VariableCollectionId:1:0',
      type: 'STRING',
      scopes: ['FONT_FAMILY'],
      values: { '1:0': 'Inter' },
    },
    {
      id: 'VariableID:2:1',
      name: 'color/primary',
      collectionId: 'VariableCollectionId:2:0',
      type: 'COLOR',
      scopes: ['ALL_SCOPES'],
      codeSyntax: { WEB: 'var(--color-primary)' },
      values: {
        '2:0': { alias: 'VariableID:1:1' },
        '2:1': { r: 1, g: 1, b: 1, a: 0.5 },
      },
    },
    {
      id: 'VariableID:2:2',
      name: 'color/brand',
      collectionId: 'VariableCollectionId:2:0',
      type: 'COLOR',
      scopes: ['ALL_SCOPES'],
      values: { '2:0': { alias: 'VariableID:9:9' }, '2:1': { alias: 'VariableID:8:8' } },
    },
  ],
  remote: [{ id: 'VariableID:9:9', name: 'brand/main', collection: 'Library' }],
};

describe('Figma variables → W3C DTCG', () => {
  it('groups by collection and name, with DTCG 2025.10 colour and dimension values', () => {
    const { tokens, count, collections } = toDtcg(RAW);
    expect(count).toBe(7);
    expect(collections).toBe(2);
    expect(tokens.Primitives).toMatchObject({
      blue: {
        '500': {
          $type: 'color',
          $value: { colorSpace: 'srgb', components: [0.2, 0.4, 1], hex: '#3366ff' },
        },
      },
      space: {
        '1_5': { $type: 'dimension', $value: { value: 12, unit: 'px' }, $description: 'Small gap' },
      },
      weight: { bold: { $type: 'fontWeight', $value: 700 } },
      opacity: { muted: { $type: 'number', $value: 0.6 } },
      font: { body: { $type: 'fontFamily', $value: 'Inter' } },
    });
  });

  it('turns aliases into references and keeps the other modes under $extensions', () => {
    const { tokens } = toDtcg(RAW);
    const theme = tokens.Theme as Record<string, Record<string, Record<string, unknown>>>;
    expect(theme.color?.primary).toEqual({
      $type: 'color',
      $value: '{Primitives.blue.500}',
      $extensions: {
        'com.figma': {
          modes: {
            Light: '{Primitives.blue.500}',
            Dark: {
              colorSpace: 'srgb',
              components: [1, 1, 1],
              alpha: 0.5,
              hex: '#ffffff',
            },
          },
          codeSyntax: { WEB: 'var(--color-primary)' },
        },
      },
    });
    // A library variable resolves by its name; an unknown one is marked, never dropped.
    expect(theme.color?.brand?.$value).toBe('{Library.brand.main}');
    const brand = theme.color?.brand as
      | { $extensions: { 'com.figma': { modes: Record<string, string> } } }
      | undefined;
    expect(brand?.$extensions['com.figma'].modes.Dark).toBe('{_unresolved.VariableID:8:8}');
    expect(theme.$extensions).toEqual({
      'com.figma': { modes: ['Light', 'Dark'], defaultMode: 'Light' },
    });
  });

  it('filters one collection by name', () => {
    const { tokens, count } = toDtcg(RAW, 'theme');
    expect(Object.keys(tokens)).toEqual(['Theme']);
    expect(count).toBe(2);
  });

  it('keeps names valid: no dots, braces or leading $', () => {
    expect(tokenSegment('1.5')).toBe('1_5');
    expect(tokenSegment('{x}')).toBe('x');
    expect(tokenSegment('$root')).toBe('root');
    expect(tokenSegment('  ')).toBe('_');
  });

  it('a token and a group with the same name: the token moves to $root', () => {
    const raw: Raw = {
      collections: [RAW.collections[0] as Raw['collections'][number]],
      remote: [],
      variables: [
        {
          id: 'a',
          name: 'gray',
          collectionId: 'VariableCollectionId:1:0',
          type: 'COLOR',
          scopes: [],
          values: { '1:0': { r: 0.5, g: 0.5, b: 0.5, a: 1 } },
        },
        {
          id: 'b',
          name: 'gray/100',
          collectionId: 'VariableCollectionId:1:0',
          type: 'COLOR',
          scopes: [],
          values: { '1:0': { r: 0.9, g: 0.9, b: 0.9, a: 1 } },
        },
      ],
    };
    const gray = (toDtcg(raw).tokens.Primitives as Record<string, Record<string, unknown>>).gray;
    expect(gray?.$root).toMatchObject({ $type: 'color' });
    expect(gray?.['100']).toMatchObject({ $type: 'color' });
  });
});
