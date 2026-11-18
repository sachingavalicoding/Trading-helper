import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TestIdea, TOOLS } from './TestIdea.jsx';

describe('Research > Test an idea', () => {
  it('lists what to test and how to make it stronger, and opens a tool on tap', () => {
    const onTool = vi.fn();
    render(<TestIdea tool="" onTool={onTool} kind="options" setKind={() => {}} />);
    expect(screen.getByText('What do you want to test?')).toBeTruthy();
    expect(screen.getByText('Make it stronger')).toBeTruthy();
    for (const t of TOOLS) expect(screen.getByText(t.label)).toBeTruthy();
    expect(TOOLS.map((t) => t.id)).toEqual(['combo', 'pattern', 'score', 'finder', 'ladder', 'late']);
    fireEvent.click(screen.getByText('Best profit ladder'));
    expect(onTool).toHaveBeenCalledWith('ladder');
  });
});
