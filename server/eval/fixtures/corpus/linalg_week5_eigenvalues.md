# Week 5: Eigenvalues and Eigenvectors

## Definition
A nonzero vector v is an eigenvector of a square matrix A with eigenvalue lambda if A v = lambda v. Geometrically, A only stretches or flips v; it does not change its direction. The zero vector is never an eigenvector, but zero can be an eigenvalue.

## The Characteristic Polynomial
Eigenvalues are the roots of det(A - lambda I) = 0. For a 2x2 matrix with trace t and determinant d, the characteristic polynomial is lambda^2 - t lambda + d. Always subtract lambda along the diagonal only, not from every entry.

## Finding Eigenvectors
For each eigenvalue lambda, solve (A - lambda I) v = 0 by row reduction. The solution set, minus the zero vector, is the set of eigenvectors; together with zero it forms the eigenspace for lambda.

## Diagonalization
A is diagonalizable if A = P D P^(-1), where D is diagonal with the eigenvalues and the columns of P are corresponding linearly independent eigenvectors. An n x n matrix with n distinct eigenvalues is always diagonalizable. Diagonalization makes powers easy: A^k = P D^k P^(-1).

## Determinants
The determinant of a triangular matrix is the product of its diagonal entries. Swapping two rows negates the determinant, and scaling a row by c scales the determinant by c. A matrix is invertible if and only if its determinant is nonzero.
