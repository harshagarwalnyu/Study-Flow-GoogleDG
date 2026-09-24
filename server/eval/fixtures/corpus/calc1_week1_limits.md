# Week 1: Limits and Continuity

## Intuitive Definition of a Limit
We write lim_{x->a} f(x) = L if f(x) can be made arbitrarily close to L by taking x sufficiently close to a, but not equal to a. The value f(a) itself does not affect the limit; the function need not even be defined at a.

## The Epsilon-Delta Definition
Formally, lim_{x->a} f(x) = L means: for every epsilon > 0 there exists delta > 0 such that if 0 < |x - a| < delta then |f(x) - L| < epsilon. To prove a limit, start from |f(x) - L| < epsilon and work backwards to find a delta that depends on epsilon.

## One-Sided Limits
The left-hand limit lim_{x->a^-} f(x) considers x < a, and the right-hand limit lim_{x->a^+} f(x) considers x > a. The two-sided limit exists only if both one-sided limits exist and are equal. For the step function, the one-sided limits at 0 differ, so the limit does not exist.

## Indeterminate Forms and L'Hopital's Rule
Forms such as 0/0 and infinity/infinity are indeterminate. If lim f(x)/g(x) has the form 0/0 or infinity/infinity, L'Hopital's rule says the limit equals lim f'(x)/g'(x), provided the latter exists. Do not apply the quotient rule here: differentiate the numerator and denominator separately.

## Continuity
A function f is continuous at a if f(a) is defined, lim_{x->a} f(x) exists, and the limit equals f(a). The Intermediate Value Theorem states that a continuous function on [a, b] takes every value between f(a) and f(b).
