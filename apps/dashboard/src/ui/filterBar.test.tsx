// @vitest-environment jsdom

/**
 * `@avo/ui` FilterBar — the list toolbar every merchant and console list shares.
 * What it owes a reader regardless of which screen mounts it: a named landmark,
 * a labelled search, a count that is announced and never a fabricated zero, a
 * Clear that exists only when something is narrowing, and chips that are one
 * keyboard stop.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilterBar, FilterChips, FilterEmpty, FilterSelect } from '@avo/ui';

afterEach(cleanup);

describe('FilterBar', () => {
  it('is a named search landmark with a labelled field', () => {
    const onChange = vi.fn();
    render(
      <FilterBar
        label="Filter products"
        search={{ value: '', onChange, label: 'Search products by name', placeholder: 'Search products' }}
        count="5 products"
      />,
    );
    expect(screen.getByRole('search', { name: 'Filter products' })).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search products by name' }), {
      target: { value: 'oil' },
    });
    expect(onChange).toHaveBeenCalledWith('oil');
  });

  it('announces the count politely, and says nothing while pending', () => {
    const { rerender } = render(<FilterBar label="Filter orders" count={null} />);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');
    rerender(<FilterBar label="Filter orders" count="2 of 9 orders" />);
    expect(screen.getByRole('status').textContent).toBe('2 of 9 orders');
  });

  it('offers Clear filters only while something is narrowing', () => {
    const { rerender } = render(<FilterBar label="Filter orders" count={null} />);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
    const onClear = vi.fn();
    rerender(<FilterBar label="Filter orders" count={null} onClear={onClear} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});

function Chips() {
  const [value, setValue] = useState<'' | 'money' | 'risk'>('');
  return (
    <FilterChips
      label="Kind"
      value={value}
      onChange={setValue}
      options={[
        { value: '', label: 'All' },
        { value: 'money', label: 'Money' },
        { value: 'risk', label: 'Risk' },
      ]}
    />
  );
}

describe('FilterChips', () => {
  it('is one tab stop; arrows, Home and End move the selection', () => {
    render(<Chips />);
    const group = screen.getByRole('radiogroup', { name: 'Kind' });
    const checked = () => screen.getAllByRole('radio').find((r) => r.getAttribute('aria-checked') === 'true')?.textContent;
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(checked()).toBe('Money');
    fireEvent.keyDown(group, { key: 'End' });
    expect(checked()).toBe('Risk');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(checked()).toBe('All');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(checked()).toBe('Risk');
    fireEvent.keyDown(group, { key: 'Home' });
    expect(checked()).toBe('All');
  });
});

describe('FilterSelect and FilterEmpty', () => {
  it('the select is named by its label, not its first option', () => {
    render(
      <FilterSelect
        label="Branch"
        value=""
        onChange={() => {}}
        options={[
          { value: '', label: 'All branches' },
          { value: 'BR-1', label: 'Salmiya' },
        ]}
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Branch' })).toBeTruthy();
  });

  it('names the thing and offers the escape', () => {
    const onClear = vi.fn();
    render(<FilterEmpty things="services" onClear={onClear} />);
    expect(screen.getByText('No services match these filters')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
