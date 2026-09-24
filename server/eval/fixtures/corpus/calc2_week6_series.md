# Week 6: Infinite Series and Convergence Tests

## The Divergence Test
If lim a_n != 0, then the series sum a_n diverges. The converse is false: the harmonic series sum 1/n has terms approaching 0 yet diverges. The divergence test can only prove divergence, never convergence.

## Geometric Series
The geometric series sum_{n=0}^{infinity} a r^n converges to a / (1 - r) when |r| < 1 and diverges when |r| >= 1. Identify r as the ratio between consecutive terms.

## The Integral Test and p-Series
If f is positive, continuous and decreasing with f(n) = a_n, then sum a_n and the integral from 1 to infinity of f(x) dx both converge or both diverge. As a consequence, the p-series sum 1/n^p converges if and only if p > 1.

## Comparison Tests
Direct comparison: if 0 <= a_n <= b_n and sum b_n converges, then sum a_n converges. Limit comparison: if lim a_n / b_n = c with 0 < c < infinity, both series behave the same way. Compare against p-series or geometric series.

## The Ratio Test
Let L = lim |a_{n+1} / a_n|. If L < 1 the series converges absolutely, if L > 1 it diverges, and if L = 1 the test is inconclusive. The ratio test works well for factorials and exponentials such as sum n! / 3^n.

## Alternating Series
The alternating series test: if b_n is decreasing and lim b_n = 0, then sum (-1)^n b_n converges. A series that converges but not absolutely, like the alternating harmonic series, is conditionally convergent.

## Taylor Series
The Taylor series of f about a is sum f^(n)(a) (x - a)^n / n!. About a = 0 it is called a Maclaurin series. For example, e^x = sum x^n / n! and sin(x) = x - x^3/3! + x^5/5! - ... The radius of convergence is found with the ratio test.
