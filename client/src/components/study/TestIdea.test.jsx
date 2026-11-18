import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TestIdea, TOOLS } from './TestIdea.jsx';

describe('Research > Test an idea', () => {
  it('lists what to test and how to make it stronger, and opens a tool on tap', () => {
    const onTool = vi.fn();
    render(<MemoryRouter><TestIdea tool="" onTool={onTool} kind="options" setKind={() => {}} /></MemoryRouter>);
    expect(screen.getByText('What do you want to test?')).toBeTruthy();
    expect(screen.getByText('Make it stronger')).toBeTruthy();
    for (const t of TOOLS) expect(screen.getByText(t.label)).toBeTruthy();
    expect(TOOLS.map((t) => t.id)).toEqual(['combo', 'pattern', 'score', 'finder', 'ladder', 'late']);
    fireEvent.click(screen.getByText('Best profit ladder'));
    expect(onTool).toHaveBeenCalledWith('ladder');
    // a combination is tested on the Combos page, not here
    expect(screen.getByText('A combination').closest('a').getAttribute('href')).toBe('/combos');
  });
});
