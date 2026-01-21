# Playwright with Node.js
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source files
COPY . .

# Expose port
ENV PORT=8080
EXPOSE 8080

# Start server
CMD ["pnpm", "dev"]
