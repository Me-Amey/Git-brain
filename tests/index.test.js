const { buildPrompt, extractMessage } = require('../src/index');

describe('Git-Brain CLI Unit Tests', () => {
  describe('buildPrompt', () => {
    it('should generate a prompt containing the branch and diff', () => {
      const diff = '+ console.log("hello");';
      const branch = 'feature/test-branch';
      const style = 'conventional';
      
      const prompt = buildPrompt(diff, branch, style);
      
      expect(prompt).toContain('Generate 3 distinct professional commit messages');
      expect(prompt).toContain(branch);
      expect(prompt).toContain(diff);
      expect(prompt).toContain(style);
    });
  });

  describe('extractMessage', () => {
    it('should successfully extract and parse a JSON array from the response', () => {
      const mockResult = {
        response: {
          text: () => '```json\\n["fix: some issue", "feat: new feature", "chore: cleanup"]\\n```'
        }
      };
      
      const result = extractMessage(mockResult);
      expect(result).toHaveLength(3);
      expect(result[0]).toBe('fix: some issue');
      expect(result[1]).toBe('feat: new feature');
    });

    it('should fallback to returning an array with the raw text if parsing fails', () => {
      const mockResult = {
        response: {
          text: () => 'Just a raw string message without JSON formatting.'
        }
      };
      
      const result = extractMessage(mockResult);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('Just a raw string message without JSON formatting.');
    });
  });
});
