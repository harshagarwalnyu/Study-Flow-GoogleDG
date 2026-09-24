# Week 3: Derivative Rules

## The Power Rule
For any real number n, the derivative of x^n is n x^(n-1). For example, d/dx x^5 = 5x^4 and d/dx x^(1/2) = (1/2) x^(-1/2). The power rule does not apply to exponential functions such as 2^x, where the variable is in the exponent.

## The Product Rule
If f and g are differentiable, then (fg)' = f'g + fg'. A common mistake is to write (fg)' = f'g', which is false: for f(x) = x and g(x) = x, (x * x)' = 2x but f'g' = 1. Always keep both terms of the product rule.

## The Quotient Rule
For g(x) != 0, (f/g)' = (f'g - fg') / g^2. The order of the terms in the numerator matters because subtraction is not commutative. A mnemonic is "low d-high minus high d-low, over the square of what's below."

## The Chain Rule
If y = f(g(x)), then dy/dx = f'(g(x)) * g'(x). Differentiate the outer function, evaluated at the inner function, then multiply by the derivative of the inner function. For example, d/dx sin(x^2) = cos(x^2) * 2x. Forgetting to multiply by the inner derivative 2x is the most common chain rule error. In Leibniz notation, dy/dx = (dy/du)(du/dx) with u = g(x).

## Derivatives of Trigonometric Functions
The derivative of sin(x) is cos(x), and the derivative of cos(x) is -sin(x). The derivative of tan(x) is sec^2(x). These results assume x is measured in radians; in degrees an extra factor of pi/180 appears.

## Implicit Differentiation
When y is defined implicitly, for example x^2 + y^2 = 25, differentiate both sides with respect to x and treat y as a function of x. This gives 2x + 2y (dy/dx) = 0, so dy/dx = -x/y. Every time you differentiate a term containing y, the chain rule contributes a factor of dy/dx.
