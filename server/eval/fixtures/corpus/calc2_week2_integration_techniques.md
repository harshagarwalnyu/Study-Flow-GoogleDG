# Week 2: Techniques of Integration

## U-Substitution
Substitution reverses the chain rule. To evaluate the integral of f(g(x)) g'(x) dx, let u = g(x), so du = g'(x) dx, and the integral becomes the integral of f(u) du. For definite integrals, remember to change the limits of integration to the corresponding u-values, or substitute back before evaluating.

## Integration by Parts
Integration by parts reverses the product rule: the integral of u dv equals uv minus the integral of v du. Choose u using the LIATE ordering: Logarithmic, Inverse trig, Algebraic, Trigonometric, Exponential. For the integral of x e^x dx, take u = x and dv = e^x dx, giving x e^x - e^x + C. Sometimes integration by parts must be applied twice, as with the integral of e^x sin(x) dx.

## Partial Fractions
A rational function P(x)/Q(x) with deg P < deg Q can be split into simpler fractions. For distinct linear factors, 1/((x-1)(x+2)) = A/(x-1) + B/(x+2). Solve for A and B by clearing denominators and substituting convenient values of x. If deg P >= deg Q, perform polynomial long division first.

## Trigonometric Substitution
For integrands containing sqrt(a^2 - x^2), substitute x = a sin(theta). For sqrt(a^2 + x^2), use x = a tan(theta), and for sqrt(x^2 - a^2), use x = a sec(theta). After integrating, draw a right triangle to convert back to x.

## Improper Integrals
An integral over an infinite interval, or of a function with a vertical asymptote in the interval, is improper. Define it as a limit: the integral from 1 to infinity of f(x) dx is the limit as t -> infinity of the integral from 1 to t. The p-integral from 1 to infinity of 1/x^p converges if and only if p > 1.
