import SwiftUI

/// `crc doctor`, rendered.
struct SetupView: View {
    @ObservedObject private var doctor = DoctorModel.shared
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Button {
                    isExpanded.toggle()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                        Text("Setup")
                            .font(.system(size: 11, weight: .semibold))
                    }
                    .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)

                Spacer()

                Text(summary)
                    .font(.system(size: 11))
                    .foregroundStyle(doctor.isChecking ? .secondary : summaryColor)

                Button {
                    Task { await doctor.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 10, weight: .semibold))
                }
                .buttonStyle(.borderless)
                .disabled(doctor.isChecking)
                .help("Run the checks again")
            }

            // Collapsed still shows whatever is wrong: a problem the user has to
            // expand a section to find is a problem they will not fix.
            ForEach(isExpanded ? (doctor.report?.checks ?? []) : doctor.problems) { check in
                CheckRow(check: check)
            }
        }
        .padding(12)
    }

    private var summary: String {
        if doctor.isChecking { return "checking…" }
        guard let report = doctor.report else { return "not checked" }
        if report.healthy && doctor.problems.isEmpty { return "all good" }
        let count = doctor.problems.count
        return report.healthy ? "\(count) warning\(count == 1 ? "" : "s")" : "needs attention"
    }

    private var summaryColor: Color {
        guard let report = doctor.report else { return .secondary }
        if !report.healthy { return .red }
        return doctor.problems.isEmpty ? .secondary : .orange
    }
}

private struct CheckRow: View {
    let check: DoctorCheck

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: symbol)
                .font(.system(size: 11))
                .foregroundStyle(tint)
                .frame(width: 13)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(check.label)
                        .font(.system(size: 12, weight: .medium))
                    Text(check.detail)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if let fix = check.fix {
                    Text(fix)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Spacer(minLength: 2)

            if let action = DoctorFix.action(for: check) {
                Button(action.buttonTitle) {
                    action.perform()
                }
                .controlSize(.small)
            }
        }
    }

    private var symbol: String {
        switch check.level {
        case .ok: return "checkmark.circle.fill"
        case .warn: return "exclamationmark.triangle.fill"
        case .bad: return "xmark.octagon.fill"
        }
    }

    private var tint: Color {
        switch check.level {
        case .ok: return .green
        case .warn: return .orange
        case .bad: return .red
        }
    }
}
