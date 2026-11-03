package billingexpr

import (
	"fmt"
	"math"

	"github.com/expr-lang/expr/ast"
	"github.com/expr-lang/expr/parser"
)

// TextCostUpperBound bounds a supported non-negative pricing expression over
// every token value up to the supplied limits. Both conditional branches are
// included: evaluating only the maximum token vector can miss a dearer short
// context tier, cache price, or a time/request-dependent surcharge.
// Unsupported arithmetic fails closed instead of guessing at a hard budget.
func TextCostUpperBound(expression string, input, output float64) (float64, error) {
	if input < 0 || output < 0 || math.IsNaN(input+output) || math.IsInf(input+output, 0) {
		return 0, fmt.Errorf("invalid text token bounds")
	}
	if _, err := CompileFromCache(expression); err != nil {
		return 0, err
	}
	_, body := ParseExprVersion(expression)
	tree, err := parser.Parse(body)
	if err != nil {
		return 0, err
	}
	bound, err := textNodeUpperBound(tree.Node, input, output)
	if err == nil && (bound < 0 || math.IsNaN(bound) || math.IsInf(bound, 0)) {
		err = fmt.Errorf("non-finite text billing bound")
	}
	return bound, err
}

func textNodeUpperBound(node ast.Node, input, output float64) (float64, error) {
	if value, ok := requestRuleNumber(node); ok {
		if value >= 0 && !math.IsNaN(value) && !math.IsInf(value, 0) {
			return value, nil
		}
	}
	switch node := node.(type) {
	case *ast.IdentifierNode:
		switch node.Value {
		case "p", "cc":
			// Omitted long-lived cache categories can be folded into these
			// dimensions at up to twice their physical input token count.
			return 2 * input, nil
		case "len", "cr", "cc1h", "cc12h":
			return input, nil
		case "c":
			return output, nil
		case "img", "img_cr", "img_o", "ai", "ao":
			return 0, nil // The caller has already required ordinary text.
		}
	case *ast.ConditionalNode:
		left, err := textNodeUpperBound(node.Exp1, input, output)
		if err != nil {
			return 0, err
		}
		right, err := textNodeUpperBound(node.Exp2, input, output)
		return math.Max(left, right), err
	case *ast.BinaryNode:
		left, err := textNodeUpperBound(node.Left, input, output)
		if err != nil {
			return 0, err
		}
		right, err := textNodeUpperBound(node.Right, input, output)
		if err != nil {
			return 0, err
		}
		switch node.Operator {
		case "+":
			return left + right, nil
		case "*":
			return left * right, nil
		case "/":
			if divisor, literal := requestRuleNumber(node.Right); literal && divisor > 0 {
				return left / divisor, nil
			}
		}
	case *ast.CallNode:
		if name, ok := node.Callee.(*ast.IdentifierNode); ok {
			return textCallUpperBound(name.Value, node.Arguments, input, output)
		}
	case *ast.BuiltinNode:
		return textCallUpperBound(node.Name, node.Arguments, input, output)
	}
	return 0, fmt.Errorf("pricing expression has no supported text cost bound")
}

func textCallUpperBound(name string, args []ast.Node, input, output float64) (float64, error) {
	if name == "tier" && len(args) == 2 {
		return textNodeUpperBound(args[1], input, output)
	}
	if name == "fixed" && len(args) == 1 {
		amount, err := textNodeUpperBound(args[0], input, output)
		return amount * 1_000_000, err
	}
	if (name == "max" || name == "min") && len(args) == 2 {
		left, err := textNodeUpperBound(args[0], input, output)
		if err != nil {
			return 0, err
		}
		right, err := textNodeUpperBound(args[1], input, output)
		if name == "max" {
			return math.Max(left, right), err
		}
		return math.Min(left, right), err
	}
	if (name == "ceil" || name == "floor" || name == "abs") && len(args) == 1 {
		value, err := textNodeUpperBound(args[0], input, output)
		if name == "ceil" {
			return math.Ceil(value), err
		}
		if name == "floor" {
			return math.Floor(value), err
		}
		return value, err // Supported operands are non-negative.
	}
	return 0, fmt.Errorf("pricing function %q has no supported text cost bound", name)
}
