export class Matrix {
  constructor(rows, cols, values = null) {
    this.rows = rows;
    this.cols = cols;
    this.data = [];

    for (let r = 0; r < rows; r += 1) {
      const row = [];
      for (let c = 0; c < cols; c += 1) {
        row.push(values && values[r] && values[r][c] !== undefined ? values[r][c] : 0);
      }
      this.data.push(row);
    }
  }

  static identity(size) {
    const m = new Matrix(size, size);
    for (let i = 0; i < size; i += 1) {
      m.data[i][i] = 1;
    }
    return m;
  }

  static fromVector(vector) {
    return new Matrix(vector.length, 1, vector.map(v => [v]));
  }

  clone() {
    return new Matrix(this.rows, this.cols, this.data.map(row => [...row]));
  }

  get(i, j) {
    if (i < 0 || i >= this.rows || j < 0 || j >= this.cols) return 0;
    return this.data[i][j];
  }

  set(i, j, value) {
    if (i < 0 || i >= this.rows || j < 0 || j >= this.cols) return false;
    this.data[i][j] = value;
    return true;
  }

  multiply(other) {
    if (this.cols !== other.rows) {
      throw new Error('Matrix dimension mismatch');
    }

    const result = new Matrix(this.rows, other.cols);
    for (let i = 0; i < this.rows; i += 1) {
      for (let j = 0; j < other.cols; j += 1) {
        let sum = 0;
        for (let k = 0; k < this.cols; k += 1) {
          sum += this.data[i][k] * other.data[k][j];
        }
        result.data[i][j] = sum;
      }
    }

    return result;
  }

  add(other) {
    if (this.rows !== other.rows || this.cols !== other.cols) {
      throw new Error('Matrix dimensions do not match');
    }

    const result = new Matrix(this.rows, this.cols);
    for (let i = 0; i < this.rows; i += 1) {
      for (let j = 0; j < this.cols; j += 1) {
        result.data[i][j] = this.data[i][j] + other.data[i][j];
      }
    }
    return result;
  }

  subtract(other) {
    if (this.rows !== other.rows || this.cols !== other.cols) {
      throw new Error('Matrix dimensions do not match');
    }

    const result = new Matrix(this.rows, this.cols);
    for (let i = 0; i < this.rows; i += 1) {
      for (let j = 0; j < this.cols; j += 1) {
        result.data[i][j] = this.data[i][j] - other.data[i][j];
      }
    }
    return result;
  }

  transpose() {
    const result = new Matrix(this.cols, this.rows);
    for (let i = 0; i < this.rows; i += 1) {
      for (let j = 0; j < this.cols; j += 1) {
        result.data[j][i] = this.data[i][j];
      }
    }
    return result;
  }

  solveLinearSystem(rhs = null, tolerance = 1e-12) {
    let coefficients;
    let values;

    if (rhs !== null) {
      coefficients = this.toArray();
      values = Array.isArray(rhs) ? [...rhs] : rhs.data.map(row => row[0]);
    } else if (this.cols === this.rows + 1) {
      coefficients = this.data.map(row => row.slice(0, this.cols - 1));
      values = this.data.map(row => row[this.cols - 1]);
    } else {
      return null;
    }

    const n = coefficients.length;
    if (n === 0 || coefficients.some(row => row.length !== n) || values.length !== n) return null;
    const a = coefficients.map((row, index) => [...row, Number(values[index])]);
    const coefficientMagnitude = Math.max(...coefficients.flat().map(value => Math.abs(value)));
    if (coefficientMagnitude === 0) return null;
    const pivotTolerance = tolerance * coefficientMagnitude;

    for (let i = 0; i < n; i += 1) {
      let pivot = i;
      for (let j = i + 1; j < n; j += 1) {
        if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) {
          pivot = j;
        }
      }

      if (Math.abs(a[pivot][i]) < pivotTolerance) {
        return null;
      }

      if (pivot !== i) {
        [a[i], a[pivot]] = [a[pivot], a[i]];
      }

      const pivotValue = a[i][i];
      for (let j = i; j <= n; j += 1) {
        a[i][j] /= pivotValue;
      }

      for (let r = 0; r < n; r += 1) {
        if (r === i) continue;
        const factor = a[r][i];
        if (factor === 0) continue;
        for (let c = i; c <= n; c += 1) {
          a[r][c] -= factor * a[i][c];
        }
      }
    }

    return a.map(row => row[n]);
  }

  solveLeastSquares(rhs, tolerance = 1e-12) {
    const values = Array.isArray(rhs) ? rhs : rhs.data.map(row => row[0]);
    if (values.length !== this.rows || this.rows === 0 || this.cols === 0) return null;
    const magnitude = Math.max(...this.data.flat().map(value => Math.abs(value)));
    if (magnitude === 0) return null;
    const qrTolerance = tolerance * magnitude;

    if (this.rows >= this.cols) {
      const q = Array.from({ length: this.cols }, () => Array(this.rows).fill(0));
      const r = Array.from({ length: this.cols }, () => Array(this.cols).fill(0));

      for (let column = 0; column < this.cols; column += 1) {
        const vector = this.data.map(row => row[column]);
        for (let previous = 0; previous < column; previous += 1) {
          let projection = 0;
          for (let row = 0; row < this.rows; row += 1) {
            projection += vector[row] * q[previous][row];
          }
          r[previous][column] = projection;
          for (let row = 0; row < this.rows; row += 1) {
            vector[row] -= projection * q[previous][row];
          }
        }

        const norm = Math.hypot(...vector);
        if (norm < qrTolerance) return this._regularizedLeastSquares(values, tolerance, magnitude);
        r[column][column] = norm;
        for (let row = 0; row < this.rows; row += 1) {
          q[column][row] = vector[row] / norm;
        }
      }

      const projected = [];
      for (let column = 0; column < this.cols; column += 1) {
        let value = 0;
        for (let row = 0; row < this.rows; row += 1) {
          value += q[column][row] * values[row];
        }
        projected.push(value);
      }

      const solution = Array(this.cols).fill(0);
      for (let row = this.cols - 1; row >= 0; row -= 1) {
        let value = projected[row];
        for (let column = row + 1; column < this.cols; column += 1) {
          value -= r[row][column] * solution[column];
        }
        solution[row] = value / r[row][row];
      }
      return solution;
    }

    const transpose = this.transpose();
    const valueVector = Matrix.fromVector(values);
    const rowGram = this.multiply(transpose);
    const dualSolution = rowGram.solveLinearSystem(valueVector, tolerance);
    if (!dualSolution) return null;
    return transpose.multiply(Matrix.fromVector(dualSolution)).data.map(row => row[0]);
  }

  _regularizedLeastSquares(values, tolerance, magnitude = 1) {
    const transpose = this.transpose();
    const normalMatrix = transpose.multiply(this);
    const normalValues = transpose.multiply(Matrix.fromVector(values));
    const regularization = Math.max(tolerance * magnitude * magnitude, Number.EPSILON * magnitude * magnitude);
    for (let index = 0; index < normalMatrix.rows; index += 1) {
      normalMatrix.data[index][index] += regularization;
    }
    return normalMatrix.solveLinearSystem(normalValues, tolerance * 0.01 || 1e-14);
  }

  rank(tolerance = 1e-10) {
    const values = this.toArray();
    const magnitude = Math.max(...values.flat().map(value => Math.abs(value)));
    if (magnitude === 0) return 0;
    const threshold = tolerance * magnitude;
    let rank = 0;
    let column = 0;
    while (rank < this.rows && column < this.cols) {
      let pivot = rank;
      for (let row = rank + 1; row < this.rows; row += 1) {
        if (Math.abs(values[row][column]) > Math.abs(values[pivot][column])) pivot = row;
      }
      if (Math.abs(values[pivot][column]) <= threshold) {
        column += 1;
        continue;
      }
      [values[rank], values[pivot]] = [values[pivot], values[rank]];
      for (let row = rank + 1; row < this.rows; row += 1) {
        const factor = values[row][column] / values[rank][column];
        for (let current = column; current < this.cols; current += 1) {
          values[row][current] -= factor * values[rank][current];
        }
      }
      rank += 1;
      column += 1;
    }
    return rank;
  }

  toArray() {
    return this.data.map(row => [...row]);
  }
}
