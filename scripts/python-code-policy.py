import ast
import io
import sys
import tokenize


def inspect(path):
    with tokenize.open(path) as stream:
        source = stream.read()
    issues = []
    try:
        tree = ast.parse(source, filename=path)
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.COMMENT:
                if token.start == (1, 0) and token.string.startswith('#!'):
                    continue
                issues.append((token.start[0], 'Comments are forbidden in code; put explanations in docs.'))
        for node in ast.walk(tree):
            if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and ast.get_docstring(node) is not None:
                issues.append((node.body[0].lineno, 'Docstrings are forbidden in code; put explanations in docs.'))
    except (SyntaxError, tokenize.TokenError) as error:
        issues.append((getattr(error, 'lineno', 1), str(error)))
    return issues


def main():
    failed = False
    for path in sys.argv[1:]:
        for line, message in inspect(path):
            print(f'{path}:{line}: {message}', file=sys.stderr)
            failed = True
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
